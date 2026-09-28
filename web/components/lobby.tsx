import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  accountKey,
  accountQuery,
  accountText,
  DEFAULT_NAME,
  nameOrDefault,
  refreshAccount,
  type Account,
  storedSecret,
} from "../lib/account.js";
import { getJson, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import {
  claim,
  deckToSubmit,
  newSeedShare,
  parseDeck,
  shareFor,
  storedDeckJson,
  withShare,
  type BotList,
  type DeckList,
  type DeckPreset,
  type JoinOutcome,
  type SeedShare,
} from "../lib/join.js";
import type { StoredSeat } from "../lib/seat.js";

interface DeckStatus {
  messages: string[];
  tone: "ok" | "ng" | "";
}

const NO_DECK_STATUS: DeckStatus = { messages: [], tone: "" };

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
  const [deckStatus, setDeckStatus] = useState(NO_DECK_STATUS);
  const [room, setRoom] = useState("");

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
    retry: false,
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
  // デッキはいまの画面の別のタブで組むこともあるので、組んだかどうかは読み直す。
  const deckJson = useSyncExternalStore(subscribeStorage, storedDeckJson);
  const hasDeck = useMemo(() => parseDeck(deckJson).length > 0, [deckJson]);
  const chosenBot = bot ?? botNames[0]?.name ?? "";
  const chosenBotDeck = botDeck ?? decks[0]?.label ?? "";
  const chosenOwnDeck = ownDeck ?? (hasDeck ? "" : (decks[0]?.label ?? ""));

  /**
   * サーバへ頼みを送っているあいだは、次の頼みを送らせない。
   *
   * **2 つを重ねない。** 相手さがしで席が決まるのと AI との対戦が始まるのが重なると、2 局を抱え、
   * 画面はあとに開いた 1 局しか持たない。開かなかった 1 局は持ち時間が尽きて負けとして残る。
   * 相手さがしの押し直しも同じで、先の頼みで席が決まると、あとの頼みがキューに残る。
   * 相手を待っているあいだの押し直しは、サーバが前のチケットを降ろすので構わない。
   * ただし席が決まったチケットは降ろさないので、押し直す前に前のチケットの席を一度取りに行く。
   */
  const [requesting, setRequesting] = useState(false);
  /** いま走っている頼み。終わったときに外すのは、自分が置いたものだけにする。 */
  const running = useRef<object | null>(null);
  const [waiting, setWaiting] = useState(false);
  /**
   * 相手を待っているチケットの持ち主。押し直した頼みをサーバが受け付けたら替わる。
   *
   * **受け付けられるまでは前の待ちを続ける。** サーバが前のチケットを降ろすのは新しい頼みを受け付けたとき
   * なので、デッキで断られたときなどに先に待ちをやめると、前のチケットがキューに残ったまま誰も席を取りに行かない。
   */
  const waitingFor = useRef<object | null>(null);
  /** 待っているチケットと、そのチケットで出したシェア。 */
  const waitingTicket = useRef<{ ticket: string; share: string | undefined } | null>(null);
  /** 画面を離れたら、相手を待つのをやめる。席はもう別の画面が持っている。 */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /**
   * AI との対戦を頼んだときのシェア。返事が届かずに押し直したとき、サーバは続いている対戦の席を返すが、
   * その席のシェアはこの画面が作ったものである。覚えていないと、シェアを開けないまま入り直すことになる。
   */
  const botShare = useRef<SeedShare | null>(null);

  const run = (task: (mine: object) => Promise<void>) => {
    const mine = {};
    running.current = mine;
    setRequesting(true);
    task(mine)
      .catch((error: unknown) => {
        if (mounted.current && running.current === mine) {
          setStatus(`つながらなかった: ${messageOf(error)}`);
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

  /** 受け付けられた頼みは表示名を変えている。戻ってきたときに、前の名前を欄に出さない。 */
  const accepted = (request: { displayName?: string }) => {
    const { displayName } = request;
    if (displayName === undefined) return;
    queryClient.setQueryData<Account>(accountKey, (known) => known && { ...known, displayName });
  };

  /** 送るデッキ。規則に通らなければ、理由を出して null。 */
  const deckOrExplain = async (): Promise<DeckList | null> => {
    const outcome = await deckToSubmit();
    if (!outcome.ok) {
      setDeckStatus({ messages: outcome.errors, tone: "ng" });
      setStatus("デッキを直してから、もう一度おしてください。");
      return null;
    }
    setDeckStatus(
      outcome.sample ? { messages: ["サンプルデッキで対戦します。"], tone: "ok" } : NO_DECK_STATUS,
    );
    return outcome.deck;
  };

  const common = async (share: SeedShare | null) => ({
    secret: await secretOf(ensureAccount),
    ...(share === null ? {} : { seedShareCommit: share.commit }),
    ...(typedNow.current === null ? {} : { displayName: nameOrDefault(typedNow.current) }),
  });

  const join = async (mine: object) => {
    setStatus("デッキを送っています");
    const deck = await deckOrExplain();
    if (deck === null) return;
    const share = await newSeedShare();
    const roomCode = room.trim();
    const request = await common(share);
    const earlier = waitingTicket.current;
    if (earlier !== null) {
      const last = await claim(earlier.ticket);
      if (last?.kind === "seated") {
        waitingFor.current = null;
        return onSeated(withShare(last.seat, earlier.share));
      }
    }
    const outcome = await postJson<JoinOutcome>("/api/join", {
      ...request,
      deck: { cards: deck.cards },
      ...(roomCode === "" ? {} : { roomCode }),
    });
    if (!outcome.ok) return refused(outcome);
    accepted(request);
    /**
     * 待っているあいだに押し直すと、返事を待つあいだに前のチケットで席が決まって座席の画面へ移っていることがある。
     * そのときは開いている対戦を残し、この頼みの答えは使わない。どちらを選んでも 1 局は時間切れになる。
     */
    if (!mounted.current) return;
    // 前のチケットはサーバが降ろした。前の待ちの答えで、この頼みの表示を上書きさせない。
    waitingFor.current = mine;
    if ("seat" in outcome) return onSeated(withShare(outcome.seat, share?.share));
    setStatus("相手を待っています");
    void waitForOpponent(mine, outcome.ticket, share?.share);
  };

  const waitForOpponent = async (mine: object, ticket: string, share: string | undefined) => {
    const current = () => mounted.current && waitingFor.current === mine;
    /**
     * 待っている様子は、変わったときだけ書く。押し直した頼みが断られたとき、
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
    waitingTicket.current = { ticket, share };
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
              // 頼みが走っていれば、降ろしたのはこのタブの押し直しである。表示はその頼みが書く。
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
        waitingTicket.current = null;
        if (mounted.current) setWaiting(false);
      }
    }
  };

  const joinBot = async () => {
    setStatus("AI との対戦を用意しています");
    let deck: { deckPreset: string } | { deck: DeckList };
    if (chosenOwnDeck === "") {
      const built = await deckOrExplain();
      if (built === null) return;
      deck = { deck: { cards: built.cards } };
    } else {
      deck = { deckPreset: chosenOwnDeck };
    }
    const share = await newSeedShare();
    // 頼む前に失敗したら、前に頼んだときのシェアを残す。そちらの頼みはサーバに届いているかもしれない。
    const request = await common(share);
    const earlier = botShare.current;
    botShare.current = share;
    const outcome = await postJson<JoinOutcome>("/api/join-bot", {
      ...request,
      bot: chosenBot,
      botDeck: chosenBotDeck,
      ...deck,
    });
    // 終わっていない AI との対戦があれば、サーバがその席を返す。この画面が席を失っていても、そこへ戻る。
    if (!outcome.ok && outcome.code === "bot-match-live" && outcome.seat !== undefined) {
      if (!mounted.current) return;
      return onSeated(withShare(outcome.seat, shareFor(outcome.seat, earlier)));
    }
    if (!outcome.ok) {
      // 断られた頼みは対戦を作っていない。用意している途中の対戦のシェアは、前のものである。
      botShare.current = earlier;
      return refused(outcome);
    }
    accepted(request);
    // 画面を離れていたら座席を覚えない。AI との対戦は、次に頼んだときにサーバがその席を返す。
    if (mounted.current && "seat" in outcome) onSeated(withShare(outcome.seat, share?.share));
  };

  const botStatus = bots.isError
    ? `AI の一覧を読めませんでした: ${messageOf(bots.error)}`
    : bots.isSuccess && botNames.length === 0
      ? "サーバに AI が置かれていません（README の「AI と対戦する」）。"
      : "";

  return (
    <section id="join">
      <h2>対戦に入る</h2>
      {remembered !== null && (
        <p>
          {/* 新しく対戦に入ると、覚えている座席を置き換える。指していた対戦へ戻る道を先に出す。
              頼みや待ちの途中で戻ると、その答えが戻った座席を置き換えるか、誰も取らないチケットが残る。 */}
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
          onChange={(event) => setRoom(event.target.value)}
        />
      </label>

      <h2>デッキ</h2>
      <p className="note">
        いまの画面で組んだデッキを使います。組んでいなければサンプルデッキを使います。デッキを組む画面は、
        <a href="/">いまの画面</a> にあります。
      </p>
      <div className="deck-actions">
        <button id="join-button" disabled={requesting} onClick={() => run((mine) => join(mine))}>
          対戦をさがす
        </button>
      </div>
      <div id="deck-status" className={`deck-status ${deckStatus.tone}`}>
        {deckStatus.messages.map((message, index) => (
          // 同じ文言の違反が並ぶことがある。並びは届いた答えのまま変わらない。
          // oxlint-disable-next-line react/no-array-index-key
          <p key={index}>{message}</p>
        ))}
      </div>

      <h2>AI と対戦する</h2>
      <p className="note">
        学習した AI と指します。レーティングは動きません。自分のデッキは、組んだものか、AI
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
            <option value="">組んだデッキ</option>
            {decks.map((deck) => (
              <option key={deck.label} value={deck.label}>
                {deckName(deck)}
              </option>
            ))}
          </select>
        </label>
        <button
          id="bot-button"
          disabled={requesting || waiting || botNames.length === 0}
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

function subscribeStorage(onChange: () => void): () => void {
  addEventListener("storage", onChange);
  return () => removeEventListener("storage", onChange);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
