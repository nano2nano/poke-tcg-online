import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { accountKey, accountQuery, accountText, storedSecret } from "../lib/account.js";
import { getJson, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import {
  claim,
  deckToSubmit,
  newSeedShare,
  shareFor,
  storedDeck,
  withShare,
  type BotList,
  type ClaimOutcome,
  type DeckList,
  type DeckPreset,
  type JoinOutcome,
  type SeedShare,
} from "../lib/join.js";
import type { StoredSeat } from "../lib/seat.js";

/**
 * 走っている入り方。`queue` は相手さがし（待っているあいだも含む）、`bot` は AI との対戦の用意である。
 *
 * **2 つを重ねない。** 相手さがしで席が決まるのと AI との対戦が始まるのが重なると、2 局を抱え、
 * 画面はあとに開いた 1 局しか持たない。開かなかった 1 局は持ち時間が尽きて負けとして残る。
 */
type Joining = "queue" | "bot";

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
  onSeated,
}: {
  status: string;
  onSeated: (seated: StoredSeat) => void;
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
  // 作るのはプレイヤーがまだいないときなので、付ける名前は打った名前か既定の名前である。
  const account = useQuery(accountQuery(() => typedName?.trim() || "ななし"));
  const name = typedName ?? account.data?.displayName ?? "ななし";
  const ensureAccount = () =>
    queryClient.fetchQuery(accountQuery(() => typedName?.trim() || "ななし"));

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
  const [hasDeck] = useState(() => storedDeck().length > 0);
  const chosenBot = bot ?? botNames[0]?.name ?? "";
  const chosenBotDeck = botDeck ?? decks[0]?.label ?? "";
  const chosenOwnDeck = ownDeck ?? (hasDeck ? "" : (decks[0]?.label ?? ""));

  const [joining, setJoining] = useState<Joining | null>(null);
  /** いま走っている入り方。終わったときに外すのは、自分が置いたものだけにする。 */
  const running = useRef<object | null>(null);
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

  const run = (kind: Joining, task: (mine: object) => Promise<void>) => {
    const mine = {};
    running.current = mine;
    setJoining(kind);
    task(mine)
      .catch((error: unknown) => {
        if (mounted.current) setStatus(`つながらなかった: ${messageOf(error)}`);
      })
      .finally(() => {
        if (running.current !== mine) return;
        running.current = null;
        if (mounted.current) setJoining(null);
      });
  };

  /** 断られた。アカウントが見つからないときは、覚えているプレイヤーを読み直させる。 */
  const refused = (outcome: { errors: string[]; code?: string }) => {
    if (outcome.code === "account-not-found") {
      void queryClient.invalidateQueries({ queryKey: accountKey });
    }
    setStatus(`対戦に入れませんでした:\n${outcome.errors.join("\n")}`);
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
    ...(typedName === null ? {} : { displayName: typedName.trim() || "ななし" }),
  });

  const join = async (mine: object) => {
    setStatus("デッキを送っています");
    const deck = await deckOrExplain();
    if (deck === null) return;
    const share = await newSeedShare();
    const roomCode = room.trim();
    const outcome = await postJson<JoinOutcome>("/api/join", {
      ...(await common(share)),
      deck: { cards: deck.cards },
      ...(roomCode === "" ? {} : { roomCode }),
    });
    if (!outcome.ok) return refused(outcome);
    if ("seat" in outcome) return onSeated(withShare(outcome.seat, share?.share));
    setStatus("相手を待っています");
    await waitForOpponent(mine, outcome.ticket, share?.share);
  };

  const waitForOpponent = async (mine: object, ticket: string, share: string | undefined) => {
    // 押し直したら前の待ちは降りる。降りた待ちの答えで、次の待ちの表示を上書きしない。
    const current = () => mounted.current && running.current === mine;
    while (current()) {
      let claimed: ClaimOutcome | null = null;
      try {
        claimed = await claim(ticket);
        if (current()) setStatus("相手を待っています");
      } catch {
        /**
         * **1 度取りに行けなかっただけで待つのをやめない。** 席はもう取れているかもしれず、
         * やめるとその対戦に座らないまま時間切れで負ける。チケットは何度でも使える。
         */
        if (current()) setStatus("相手を待っています（つながりが悪いので取り直しています）");
      }
      if (!current()) return;
      switch (claimed?.kind) {
        case "seated":
          return onSeated(withShare(claimed.seat, share));
        case "finished":
          // 席に着く前に終わっている。指していなくても記録には残り、レーティングも動いている。
          setStatus("この対戦は、席に着く前に終わりました。「一覧を出す」から読み返せます。");
          void queryClient.invalidateQueries({ queryKey: accountKey });
          return;
        case "dropped":
          setStatus("別のタブから入り直したので、このタブは待つのをやめました。");
          return;
        case "waiting":
        case undefined:
          break;
        default:
          /**
           * **知らない答えで待ち続けない。** 入れ替えのあとに古いタブが新しい答えを受け取ることがあり、
           * 待ち続けると永久に問い合わせ続ける。
           */
          setStatus("受付の記録が無くなりました。もう一度「対戦をさがす」を押してください。");
          return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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
    const earlier = botShare.current;
    botShare.current = share;
    const outcome = await postJson<JoinOutcome>("/api/join-bot", {
      ...(await common(share)),
      bot: chosenBot,
      botDeck: chosenBotDeck,
      ...deck,
    });
    // 終わっていない AI との対戦があれば、サーバがその席を返す。この画面が席を失っていても、そこへ戻る。
    if (!outcome.ok && outcome.code === "bot-match-live" && outcome.seat !== undefined) {
      return onSeated(withShare(outcome.seat, shareFor(outcome.seat, earlier)));
    }
    if (!outcome.ok) return refused(outcome);
    if ("seat" in outcome) onSeated(withShare(outcome.seat, share?.share));
  };

  const botStatus = bots.isError
    ? `AI の一覧を読めませんでした: ${messageOf(bots.error)}`
    : bots.isSuccess && botNames.length === 0
      ? "サーバに AI が置かれていません（README の「AI と対戦する」）。"
      : "";

  return (
    <section id="join">
      <h2>対戦に入る</h2>
      <label>
        名前 <input id="name" value={name} onChange={(event) => setTypedName(event.target.value)} />
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
        <button
          id="join-button"
          disabled={joining === "bot"}
          onClick={() => run("queue", (mine) => join(mine))}
        >
          対戦をさがす
        </button>
      </div>
      <div id="deck-status" className={`deck-status ${deckStatus.tone}`}>
        {deckStatus.messages.map((message) => (
          <p key={message}>{message}</p>
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
          disabled={joining !== null || botNames.length === 0}
          onClick={() => run("bot", joinBot)}
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
