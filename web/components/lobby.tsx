import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  accountKey,
  accountQuery,
  accountText,
  DEFAULT_NAME,
  nameOrDefault,
  refreshAccount,
  storedSecret,
} from "../lib/account.js";
import { getJson, messageOf, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import {
  claim,
  builtDeck,
  liveSeatOf,
  newSeedShare,
  shareFor,
  withShare,
  type BotList,
  type DeckList,
  type DeckPreset,
  type JoinOutcome,
  type SeedShare,
} from "../lib/join.js";
import { parseDeck, storedDeckJson, subscribeDeck } from "../lib/deck.js";
import type { StoredSeat } from "../lib/seat.js";
import { DeckBuilder, NO_DECK_STATUS, type DeckMessage } from "./deck-builder.js";

/** 覚えておくシェアの数。押すたびに増えるので、古いものから捨てる。 */
const SHARES_KEPT = 8;

/**
 * 対戦に入る画面。席が決まったら `onSeated` へ渡す。
 *
 * `status` は開いたときに出す一言で、座席を離れた理由が入る。
 */
export function Lobby({
  status: initialStatus,
  remembered,
  onSeated,
  onResume,
}: {
  status: string;
  /** 覚えている座席。繋がらずにこの画面へ戻ったときに残っている。 */
  remembered: StoredSeat | null;
  onSeated: (seated: StoredSeat) => void;
  onResume: (seated: StoredSeat) => void;
}) {
  const queryClient = useQueryClient();
  const { table } = useCardData();
  const [status, setStatus] = useState(initialStatus);
  const [deckStatus, setDeckStatus] = useState<DeckMessage>(NO_DECK_STATUS);
  const [room, setRoom] = useState("");
  /** 送る時点のルームコード。名前と同じく、押してから送るまでに直した分も送る。 */
  const roomNow = useRef("");

  /**
   * 人が打った表示名。打つまでは null で、欄にはプレイヤーの表示名を出す。
   *
   * 読み込みは非同期なので、返ってくる前に名前を打って「対戦をさがす」を押せる。そこで欄を
   * 埋め直すと、打った名前が消えてから送られる。表示名の変更は対局ログに残って取り消せないので、
   * 送るのも打ったときだけにする。
   */
  const [typedName, setTypedName] = useState<string | null>(null);
  /** 送る時点の欄の値。押してから送るまでのあいだに打ち足した分も送る。 */
  const typedNow = useRef<string | null>(null);
  const accountOptions = accountQuery();
  const account = useQuery(accountOptions);
  const name = typedName ?? account.data?.displayName ?? DEFAULT_NAME;
  const ensureAccount = () => queryClient.fetchQuery(accountOptions);

  const bots = useQuery({
    queryKey: ["bots"],
    queryFn: () => getJson<BotList>("/api/bots"),
    staleTime: Infinity,
  });
  const botNames = bots.data?.bots ?? [];
  const decks = bots.data?.decks ?? [];
  const deckName = (deck: DeckPreset) => table[deck.ace]?.name ?? deck.label;
  const [bot, setBot] = useState<string | null>(null);
  const [botDeck, setBotDeck] = useState<string | null>(null);
  /**
   * 自分のデッキの欄で人が選んだもの。選ぶまでは、組んだデッキが無ければ表の先頭のデッキにする。
   * 空のまま押すとサンプルデッキになり、AI が学んだことの無い相手になる。
   */
  const [ownDeck, setOwnDeck] = useState<string | null>(null);
  const deckJson = useSyncExternalStore(subscribeDeck, storedDeckJson);
  const hasDeck = useMemo(() => parseDeck(deckJson).length > 0, [deckJson]);
  const chosenBot = bot ?? botNames[0]?.name ?? "";
  const chosenBotDeck = botDeck ?? decks[0]?.label ?? "";
  const chosenOwnDeck = ownDeck ?? (hasDeck ? "" : (decks[0]?.label ?? ""));

  /**
   * サーバへリクエストを送っているあいだは、次のリクエストを送らせない。
   *
   * **2 つを重ねない。** 返事は送った順に届くとは限らない。あとのリクエストが前のチケットを降ろしたのに、
   * 先のリクエストの返事があとに届くと、画面は降りたチケットを待ち、あとのチケットは誰も取りに行かない席になる。
   * 相手を待っているあいだの押し直しは、サーバが前のチケットを降ろすか、決まった席を返すので構わない。
   */
  const [requesting, setRequesting] = useState(false);
  /** いま走っているリクエスト。終わったときに外すのは、自分が置いたものだけにする。 */
  const running = useRef<object | null>(null);
  const [waiting, setWaiting] = useState(false);
  /**
   * 相手を待っているチケットの持ち主。押し直したリクエストをサーバが受け付けたら替わる。
   *
   * 受け付けられるまでは前のポーリングを続ける。サーバが前のチケットを降ろすのは新しいリクエストを受け付けたとき
   * なので、デッキで断られたときなどに先にポーリングをやめると、前のチケットがキューに残ったまま誰も席を取りに行かない。
   */
  const waitingFor = useRef<object | null>(null);
  /** 画面を離れたら、相手を待つのをやめる。席はもう別の画面が持っている。 */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * サーバに届いたかもしれないリクエストのシェア。新しい順。返事が届かずに押し直すと、サーバは続いている対戦の席を
   * 返すが、その席のシェアはこの画面が作ったものである。覚えていないと、シェアを開けないまま入り直すことになる。
   *
   * 最後の 1 つだけでは足りない。待っているチケットの席が決まる前に、次のリクエストが届かずに失敗することがある。
   */
  const sentShares = useRef<SeedShare[]>([]);

  const run = (task: (mine: object) => Promise<void>) => {
    const mine = {};
    running.current = mine;
    setRequesting(true);
    task(mine)
      .catch((error: unknown) => {
        if (mounted.current && running.current === mine) {
          // fetch が届かなかったときは TypeError になる。ほかは、サーバが答えた理由である。
          const lead = error instanceof TypeError ? "つながらなかった" : "対戦に入れませんでした";
          setStatus(`${lead}: ${messageOf(error)}`);
        }
      })
      .finally(() => {
        if (running.current !== mine) return;
        running.current = null;
        if (mounted.current) setRequesting(false);
      });
  };

  /**
   * 断られた。アカウントが見つからないときは、覚えているプレイヤーを古いものとする。
   * すぐには取り直さない。取り直すとプレイヤーを作り直すので、それは次に押したときにする。
   */
  const refused = (outcome: { errors: string[]; code?: string }) => {
    if (outcome.code === "account-not-found") {
      void queryClient.invalidateQueries({ queryKey: accountKey, refetchType: "none" });
    }
    setStatus(`対戦に入れませんでした:\n${outcome.errors.join("\n")}`);
  };

  /** 受け付けられたリクエストは表示名を変えている。戻ってきたときに、前の名前を欄に出さない。 */
  const accepted = (request: { displayName?: string }) => {
    // サーバは見えない文字を落とし、長さを切ってから名前を付ける。付いた名前を読み直す。
    if (request.displayName !== undefined) refreshAccount(queryClient).catch(() => {});
  };

  const common = async (share: SeedShare | null) => ({
    secret: await secretOf(ensureAccount),
    ...(share === null ? {} : { seedShareCommit: share.commit }),
    ...(typedNow.current === null ? {} : { displayName: nameOrDefault(typedNow.current) }),
  });

  /**
   * 頼む。終わっていない対戦があればサーバがその席を返すので、この画面が席を失っていても、そこへ戻って null を返す。
   * 画面を離れていれば、送らずに null を返す。席はもう別の画面が持っている。
   */
  const send = async (
    path: string,
    request: { displayName?: string; [field: string]: unknown },
    share: SeedShare | null,
  ): Promise<JoinOutcome | null> => {
    if (!mounted.current) return null;
    if (share !== null) sentShares.current = [share, ...sentShares.current].slice(0, SHARES_KEPT);
    const outcome = await postJson<JoinOutcome>(path, request);
    const live = liveSeatOf(outcome);
    if (live !== null) {
      if (mounted.current) onSeated(withShare(live, shareFor(live, sentShares.current)));
      return null;
    }
    if (!outcome.ok) {
      // 断られたリクエストは対戦を作っていない。
      sentShares.current = sentShares.current.filter((sent) => sent !== share);
      return outcome;
    }
    accepted(request);
    return outcome;
  };

  const join = async (mine: object) => {
    setStatus("デッキを送っています");
    // 規則はサーバに照らさせる。サーバは続いている対戦を先に見るので、組み直しかけのデッキでもそこへ戻れる。
    const sent = storedDeckJson();
    const { deck, sample } = await builtDeck();
    // 組んだデッキなら、欄はいまのデッキについてのものなので残す。確かめている途中の表示も消さない。
    if (sample) setDeckStatus({ messages: ["サンプルデッキで対戦します。"], tone: "ok" });
    const share = await newSeedShare();
    const request = await common(share);
    const roomCode = roomNow.current.trim();
    const outcome = await send(
      "/api/join",
      { ...request, deck: { cards: deck.cards }, ...(roomCode === "" ? {} : { roomCode }) },
      share,
    );
    // 画面を離れていたら、この答えは使わない。キューに残ったチケットは、次に頼んだときにサーバが降ろすか、その席を返す。
    if (outcome === null || !mounted.current) return;
    if (!outcome.ok) {
      if (outcome.code !== undefined) return refused(outcome);
      // `code` の無い断りは、デッキの違反である。
      // 待つあいだに組み替えていたら、理由は送ったデッキのものなので出さない。
      if (sent !== storedDeckJson()) {
        setStatus("待つあいだにデッキが変わりました。もう一度おしてください。");
        return;
      }
      setDeckStatus({ messages: outcome.errors, tone: "ng", deck: sent });
      setStatus("デッキを直してから、もう一度おしてください。");
      return;
    }
    // 前のチケットはサーバが降ろした。前のポーリングの答えで、このリクエストの表示を上書きさせない。
    waitingFor.current = mine;
    if ("seat" in outcome) return onSeated(withShare(outcome.seat, share?.share));
    setStatus("相手を待っています");
    void waitForOpponent(mine, outcome.ticket, share?.share);
  };

  const waitForOpponent = async (mine: object, ticket: string, share: string | undefined) => {
    const current = () => mounted.current && waitingFor.current === mine;
    /**
     * 待っている様子は、変わったときだけ書く。押し直したリクエストが断られたとき、
     * 次に取りに行ったところでその理由を消さない。
     */
    let waitingText = "相手を待っています";
    const showWaiting = (text: string) => {
      if (!current() || text === waitingText || running.current !== null) return;
      waitingText = text;
      setStatus(text);
    };
    const show = (text: string) => {
      if (current()) setStatus(text);
    };
    setWaiting(true);
    try {
      while (current()) {
        const claimed = await claim(ticket);
        /**
         * **1 度取りに行けなかっただけで待つのをやめない。** 席はもう取れているかもしれず、
         * やめるとその対戦に座らないまま時間切れで負ける。チケットは何度でも使える。
         */
        showWaiting(
          claimed === null
            ? "相手を待っています（つながりが悪いので取り直しています）"
            : "相手を待っています",
        );
        if (!current()) return;
        if (claimed !== null) {
          switch (claimed.kind) {
            case "seated":
              return onSeated(withShare(claimed.seat, share));
            case "finished":
              // 席に着く前に終わっている。指していなくても記録には残り、レーティングも動いている。
              show(
                "この対戦は、席に着く前に終わりました。いまの画面の「一覧を出す」から読み返せます。",
              );
              refreshAccount(queryClient).catch(() => {});
              return;
            case "dropped":
              // リクエストが走っていれば、降ろしたのはこのタブの押し直しである。表示はそのリクエストが書く。
              if (running.current === null) {
                show("別のタブから入り直したので、このタブは待つのをやめました。");
              }
              return;
            case "waiting":
              break;
            default:
              /**
               * **知らない答えで待ち続けない。** 入れ替えのあとに古いタブが新しい答えを受け取ることがあり、
               * 待ち続けると永久にポーリングし続ける。
               */
              show("受付の記録が無くなりました。もう一度「対戦をさがす」を押してください。");
              return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    } finally {
      if (waitingFor.current === mine) {
        waitingFor.current = null;
        if (mounted.current) setWaiting(false);
      }
    }
  };

  const joinBot = async () => {
    setStatus("AI との対戦を用意しています");
    let deck: { deckPreset: string } | { deck: DeckList };
    if (chosenOwnDeck === "") {
      // 規則はサーバに照らさせる。サーバは続いている対戦を先に見るので、組み直しかけのデッキでもそこへ戻れる。
      deck = { deck: { cards: (await builtDeck()).deck.cards } };
    } else {
      deck = { deckPreset: chosenOwnDeck };
    }
    const share = await newSeedShare();
    const request = await common(share);
    const outcome = await send(
      "/api/join-bot",
      { ...request, bot: chosenBot, botDeck: chosenBotDeck, ...deck },
      share,
    );
    if (outcome === null) return;
    if (!outcome.ok) return refused(outcome);
    // 画面を離れていたら座席を覚えない。AI との対戦は、次に頼んだときにサーバがその席を返す。
    if (mounted.current && "seat" in outcome) onSeated(withShare(outcome.seat, share?.share));
  };

  const botStatus = bots.isError
    ? `AI の一覧を読めませんでした: ${messageOf(bots.error)}`
    : bots.isSuccess && botNames.length === 0
      ? "サーバに AI が置かれていません（README の「AI と対戦する」）。"
      : bots.isSuccess && decks.length === 0
        ? "AI が握れるデッキがサーバにありません。"
        : "";

  return (
    <section id="join">
      <h2>対戦に入る</h2>
      {remembered !== null && (
        <p>
          {/* 新しく対戦に入ると、覚えている座席を置き換える。指していた対戦へ戻る道を先に出す。
              リクエストやポーリングの途中で戻ると、その答えが戻った座席を置き換えるか、誰も取らないチケットが残る。 */}
          <button
            id="resume-button"
            disabled={requesting || waiting}
            onClick={() => onResume(remembered)}
          >
            指していた対戦へ戻る
          </button>
        </p>
      )}
      <label>
        名前{" "}
        <input
          id="name"
          value={name}
          onChange={(event) => {
            typedNow.current = event.target.value;
            setTypedName(event.target.value);
          }}
        />
      </label>
      <p id="account" className="note">
        {account.data !== undefined
          ? accountText(account.data)
          : account.isError
            ? `アカウントを読めませんでした: ${messageOf(account.error)}`
            : ""}
      </p>
      <label>
        ルームコード{" "}
        <input
          id="room"
          placeholder="空ならマッチングキューへ"
          value={room}
          onChange={(event) => {
            roomNow.current = event.target.value;
            setRoom(event.target.value);
          }}
        />
      </label>

      <h2>デッキ</h2>
      <p className="note">
        カード名で検索して、候補の「追加」を押します。ワザの名前や収録でも探せます。同じ名前のカードは
        HP やワザ、収録で見分けます。
        組んだデッキはこのブラウザに残ります。空のままならサンプルデッキを使います。
      </p>
      <DeckBuilder
        status={deckStatus}
        onStatus={setDeckStatus}
        actions={
          <button id="join-button" disabled={requesting} onClick={() => run((mine) => join(mine))}>
            対戦をさがす
          </button>
        }
      />

      <h2>AI と対戦する</h2>
      <p className="note">
        学習した AI と指します。レーティングは動きません。自分のデッキは、上で組んだものか、AI
        と同じ表のデッキから選べます。
      </p>
      <div className="bot-form">
        <label>
          AI{" "}
          <select id="bot" value={chosenBot} onChange={(event) => setBot(event.target.value)}>
            {botNames.map(({ name: botName }) => (
              <option key={botName} value={botName}>
                {botName}
              </option>
            ))}
          </select>
        </label>
        <label>
          AI のデッキ{" "}
          <select
            id="bot-deck"
            value={chosenBotDeck}
            onChange={(event) => setBotDeck(event.target.value)}
          >
            {decks.map((deck) => (
              <option key={deck.label} value={deck.label}>
                {deckName(deck)}
              </option>
            ))}
          </select>
        </label>
        <label>
          自分のデッキ{" "}
          <select
            id="own-deck"
            value={chosenOwnDeck}
            onChange={(event) => setOwnDeck(event.target.value)}
          >
            <option value="">上で組んだデッキ</option>
            {decks.map((deck) => (
              <option key={deck.label} value={deck.label}>
                {deckName(deck)}
              </option>
            ))}
          </select>
        </label>
        <button
          id="bot-button"
          disabled={requesting || waiting || botNames.length === 0 || decks.length === 0}
          onClick={() => run(joinBot)}
        >
          AI と対戦する
        </button>
      </div>
      <p id="bot-status" className="note">
        {botStatus}
      </p>
      <p>
        <output id="join-status">{status}</output>
      </p>
    </section>
  );
}

async function secretOf(ensureAccount: () => Promise<unknown>): Promise<string> {
  await ensureAccount();
  const secret = storedSecret();
  if (secret === null) throw new Error("プレイヤーを用意できなかった");
  return secret;
}
