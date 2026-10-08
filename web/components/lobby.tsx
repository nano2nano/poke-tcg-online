import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  accountQuery,
  accountText,
  DEFAULT_NAME,
  forgetAccount,
  nameOrDefault,
  refreshAccount,
  requireSecret,
} from "../lib/account.js";
import { messageOf, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import { savedDecksQuery, useSavedDecks } from "../lib/deck.js";
import {
  botListQuery,
  claim,
  deckRequest,
  isListed,
  leaveQueue,
  liveSeatOf,
  newSeedShare,
  presetName,
  rememberDeckChoice,
  resolveBotDeckChoice,
  resolveDeckChoice,
  shareFor,
  storedDeckChoice,
  withShare,
  type DeckChoice,
  type DeckPreset,
  type JoinOutcome,
  type SeedShare,
} from "../lib/join.js";
import type { StoredSeat } from "../lib/seat.js";
import { BotDeckOptions, savedDeckLabel, UnplayableNote, UntrainedDeckNote } from "./bot-deck.js";

/** 覚えておくシェアの数。押すたびに増えるので、古いものから捨てる。 */
const SHARES_KEPT = 8;

/**
 * 対戦に入る画面。使うデッキを 1 つ選び、人の相手をさがすか AI と対戦する。席が決まったら `onSeated` へ渡す。
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

  const bots = useQuery(botListQuery);
  const botNames = bots.data?.bots ?? [];
  const decks = bots.data?.decks ?? [];
  const deckName = (deck: DeckPreset) => presetName(deck, table);
  const [bot, setBot] = useState<string | null>(null);
  const chosenBot = bot ?? botNames[0]?.name ?? "";

  const saved = useSavedDecks();
  const savedDecks = saved.decks.data ?? [];
  const [picked, setPicked] = useState<DeckChoice | null>(storedDeckChoice);
  const choice = resolveDeckChoice(picked, savedDecks, decks);
  const [botPicked, setBotPicked] = useState<DeckChoice | null>(null);
  const botChoice = resolveBotDeckChoice(botPicked, savedDecks, decks);
  const chosenSaved = savedDecks.find(({ deckId }) => `saved:${deckId}` === choice) ?? null;
  const botSaved = savedDecks.find(({ deckId }) => `saved:${deckId}` === botChoice) ?? null;
  const choose = (next: DeckChoice) => {
    setPicked(next);
    rememberDeckChoice(next);
  };

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
  /** 待っているチケットと、席に着いたときに開くシェア。ページを移るときに降ろす。 */
  const waitingTicket = useRef<{ ticket: string; share: string | undefined } | null>(null);
  /** 画面を離れたら、相手を待つのをやめる。席に着いたか、ページを移ってチケットを降ろした。 */
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

  /**
   * 相手を待つのをやめる。降ろす前に席が決まっていたら、その卓へ移る。届かなければ null を返す。
   * 降ろさないままページを移ると、相手が見つかっても誰も取りに行かず、座らないまま時間切れで負ける。
   */
  const abandon = async (ticket: string, share: string | undefined) => {
    const outcome = await leaveQueue(ticket);
    if (outcome?.kind === "seated") onSeated(withShare(outcome.seat, share));
    return outcome;
  };
  useBlocker({
    shouldBlockFn: async ({ next }) => {
      const pending = waitingTicket.current;
      // 卓へ移るのは席に着いたときで、降ろすチケットはもう無い。
      if (pending === null || next.pathname === "/match") return false;
      if (!confirm("相手をさがすのをやめて、このページを離れますか。")) return true;
      const outcome = await abandon(pending.ticket, pending.share);
      // 降ろせたか分からないまま離れると、残ったチケットを誰も取りに行かない。ここに留まって待ち続ける。
      if (outcome === null) {
        setStatus("つながらなかったので、相手をさがすのをやめられませんでした。");
        return true;
      }
      waitingFor.current = null;
      return outcome.kind === "seated";
    },
    enableBeforeUnload: false,
  });

  /**
   * 送るデッキ。保存したデッキを選んでいたか何も選んでいなければ、保存したデッキの一覧が届いてから選ぶ。
   * 届く前の一覧で選ぶと、選んだつもりのないデッキで入る。
   */
  const deckToSend = async (chosen: DeckChoice | null, resolve: typeof resolveDeckChoice) => {
    const { playerId } = await ensureAccount();
    const presets = await queryClient.ensureQueryData(botListQuery).then(
      (answer) => answer.decks,
      () => [],
    );
    if (chosen !== null && isListed(chosen, [], presets)) {
      return deckRequest(chosen, []);
    }
    // 読めなければ、画面に出ているデッキで入る。画面も、一覧が無いものとしてデッキを選んでいる。
    const list = await queryClient
      .ensureQueryData(savedDecksQuery(queryClient, playerId))
      .catch(() => []);
    return deckRequest(resolve(chosen, list, presets), list);
  };

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
      forgetAccount(queryClient);
    }
    // `code` の無い断りは、デッキの違反である。
    const lead = outcome.code === undefined ? "デッキが規則を通りません" : "対戦に入れませんでした";
    setStatus(`${lead}:\n${outcome.errors.join("\n")}`);
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
      // ページを移っていても、続いている対戦の卓へ移る。その対戦の時計は流れている。
      onSeated(withShare(live, shareFor(live, sentShares.current)));
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
    const deck = await deckToSend(picked, resolveDeckChoice);
    const share = await newSeedShare();
    const request = await common(share);
    const roomCode = roomNow.current.trim();
    const outcome = await send(
      "/api/join",
      { ...request, ...deck, ...(roomCode === "" ? {} : { roomCode }) },
      share,
    );
    if (outcome === null) return;
    // 答えを待つあいだにページを移った。待つだけならチケットを降ろし、席が決まっていればその卓へ移る。
    if (!mounted.current) {
      if (outcome.ok) void abandon(outcome.ticket, share?.share);
      return;
    }
    if (!outcome.ok) return refused(outcome);
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
              show("この対戦は、席に着く前に終わりました。「対戦の記録」から読み返せます。");
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
        waitingTicket.current = null;
        if (mounted.current) setWaiting(false);
      }
    }
  };

  const joinBot = async () => {
    setStatus("AI との対戦を用意しています");
    const [deck, botDeck] = await Promise.all([
      deckToSend(picked, resolveDeckChoice),
      deckToSend(botPicked, resolveBotDeckChoice),
    ]);
    const share = await newSeedShare();
    const request = await common(share);
    const outcome = await send(
      "/api/join-bot",
      {
        ...request,
        bot: chosenBot,
        botDeck: "deck" in botDeck ? botDeck.deck : botDeck.deckPreset,
        ...deck,
      },
      share,
    );
    if (outcome === null) return;
    if (!outcome.ok) return refused(outcome);
    // ページを移っていても卓へ移る。AI は待たずに指し始める。
    if ("seat" in outcome) onSeated(withShare(outcome.seat, share?.share));
  };

  const botStatus = bots.isError
    ? `AI の一覧を読めませんでした: ${messageOf(bots.error)}`
    : bots.isSuccess && botNames.length === 0
      ? "サーバに AI が置かれていません（README の「AI と対戦する」）。"
      : "";

  const unplayable = chosenSaved !== null && chosenSaved.errors.length > 0;
  return (
    <section id="join">
      <header className="page-head">
        <div>
          <h1>対戦</h1>
          <p id="account" className="note">
            {account.data !== undefined
              ? accountText(account.data)
              : account.isError
                ? `アカウントを読めませんでした: ${messageOf(account.error)}`
                : ""}
          </p>
        </div>
        {remembered !== null && (
          // 新しく対戦に入ると、覚えている座席を置き換える。指していた対戦へ戻る道を先に出す。
          // リクエストやポーリングの途中で戻ると、その答えが戻った座席を置き換えるか、誰も取らないチケットが残る。
          <button
            id="resume-button"
            className="primary"
            disabled={requesting || waiting}
            onClick={() => onResume(remembered)}
          >
            指していた対戦へ戻る
          </button>
        )}
      </header>
      <output id="join-status" className="status">
        {status}
      </output>

      <section className="panel">
        <h2>名前とデッキ</h2>
        <div className="fields">
          <label>
            名前
            <input
              id="name"
              value={name}
              onChange={(event) => {
                typedNow.current = event.target.value;
                setTypedName(event.target.value);
              }}
            />
          </label>
          <label>
            デッキ
            <select
              id="deck-choice"
              value={choice}
              onChange={(event) => choose(event.target.value as DeckChoice)}
            >
              {savedDecks.length > 0 && (
                <optgroup label="保存したデッキ">
                  {savedDecks.map((deck) => (
                    <option key={deck.deckId} value={`saved:${deck.deckId}`}>
                      {savedDeckLabel(deck)}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="用意されたデッキ">
                <option value="sample">サンプルデッキ</option>
                {decks.map((deck) => (
                  <option key={deck.label} value={`preset:${deck.label}`}>
                    {deckName(deck)}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>
        <p id="deck-note" className="note">
          {unplayable ? (
            <UnplayableNote deck={chosenSaved} />
          ) : saved.failure !== null ? (
            `保存したデッキを読めませんでした: ${messageOf(saved.failure)}`
          ) : (
            <>
              デッキは<Link to="/decks">デッキのページ</Link>で組んで保存できます。
            </>
          )}
        </p>
      </section>

      <div className="panels">
        <section className="panel">
          <h2>人と対戦する</h2>
          <p className="note">相手が見つかると、対戦の卓へ移ります。</p>
          <details className="room">
            <summary>友だちと対戦する</summary>
            <div className="fields">
              <label>
                ルームコード
                <input
                  id="room"
                  placeholder="同じコードを入れた 2 人が対戦します"
                  value={room}
                  onChange={(event) => {
                    roomNow.current = event.target.value;
                    setRoom(event.target.value);
                  }}
                />
              </label>
            </div>
            <p className="note">
              入れたら「対戦をさがす」を押します。空ならマッチングキューへ入ります。
            </p>
          </details>
          <div className="actions">
            <button
              id="join-button"
              className="primary"
              disabled={requesting}
              onClick={() => run((mine) => join(mine))}
            >
              対戦をさがす
            </button>
          </div>
        </section>

        <section id="bot-join" className="panel">
          <h2>AI と対戦する</h2>
          <p className="note">
            学習した AI と、上で選んだデッキで指します。レーティングは動きません。
          </p>
          <div className="fields">
            <label>
              AI
              <select id="bot" value={chosenBot} onChange={(event) => setBot(event.target.value)}>
                {botNames.map(({ name: botName }) => (
                  <option key={botName} value={botName}>
                    {botName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              AI のデッキ
              <select
                id="bot-deck"
                value={botChoice}
                onChange={(event) => setBotPicked(event.target.value as DeckChoice)}
              >
                <BotDeckOptions presets={decks} saved={savedDecks} presetName={deckName} />
              </select>
            </label>
          </div>
          {/* 表が届くまでは、選んでいなくてもサンプルデッキを指している。 */}
          {bots.isSuccess && !botChoice.startsWith("preset:") && (
            <p id="bot-deck-note" className="note">
              <UntrainedDeckNote deck={botSaved} />
            </p>
          )}
          <div className="actions">
            <button
              id="bot-button"
              className="primary"
              disabled={requesting || waiting || botNames.length === 0}
              onClick={() => run(joinBot)}
            >
              AI と対戦する
            </button>
          </div>
          <p id="bot-status" className="note">
            {botStatus}
          </p>
        </section>
      </div>
    </section>
  );
}

async function secretOf(ensureAccount: () => Promise<unknown>): Promise<string> {
  await ensureAccount();
  return requireSecret();
}
