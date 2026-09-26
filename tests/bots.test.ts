/** AI の座席（`docs/spec/battle-server.md` 7.3 節）。 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountStore, INITIAL_RATING } from "../src/accounts.js";
import { MatchArchive } from "../src/archive.js";
import {
  BOT_PREFIX,
  botFromBytes,
  BotStore,
  deckPresets,
  presetDeck,
  type Bot,
} from "../src/bots.js";
import { validateDeck } from "../src/deck.js";
import { commitSeed, commitShare } from "../src/fingerprint.js";
import {
  applyMove,
  createGame,
  derivedView,
  encodeEntityWeights,
  encodePpoWeights,
  legalMoves,
  newEntityWeightsFile,
  newPpoWeightsFile,
  NO_KNOWLEDGE,
  positionKey,
  projectEvents,
  RevisitTracker,
  SeatKnowledge,
  type DecisionExtras,
  type GameState,
  type HiddenKnowledge,
  type Move,
  type Player,
  type PlayerView,
} from "../src/engine.js";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { BOT_MATCH_LIVE, Lobby } from "../src/lobby.js";
import type { MatchRecord } from "../src/log.js";
import {
  botCandidates,
  botExtrasFor,
  createMatch,
  legalMovesFor,
  submitMove,
  toMove,
  viewFor,
  type Match,
} from "../src/match.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, legalDecks, newMatch } from "./helpers.js";
import { startStorage } from "./worker.js";

// 重みを作るのも方策にするのも重く、重みを何本か扱うテストは既定の 5 秒に近い。遅い機械では越えるので、
// 1 本ずつ上限を足さずにファイル全体で延ばす。
vi.setConfig({ testTimeout: 30_000 });

let storage: Awaited<ReturnType<typeof startStorage>>;

beforeAll(async () => {
  storage = await startStorage();
});

afterAll(async () => {
  await storage.close();
});

const generated = new Map<string, Uint8Array>();

/**
 * 世代 0 の重み。出力の層が 0 なので、どの局面でも全候補が同じ確率になる。
 * 初期値の直交化は 1 本ごとに重く、テストの持ち時間を越えうるので、同じ組は 1 度だけ作る。
 */
function generationZero(label = "test-bot", knowledge: "tracked" | "zero" = "zero"): Uint8Array {
  const key = `${label}:${knowledge}`;
  let bytes = generated.get(key);
  if (bytes === undefined) {
    bytes = encodePpoWeights(newPpoWeightsFile(label, undefined, undefined, knowledge));
    generated.set(key, bytes);
  }
  return bytes;
}

/** 形式 6（要素の集合を読む方策）の世代 0。出力の層が 0 なので、形式 5 と同じく全候補が同じ確率になる。 */
function entityGenerationZero(label = "test-entity"): Uint8Array {
  const key = `entity:${label}`;
  let bytes = generated.get(key);
  if (bytes === undefined) {
    bytes = encodeEntityWeights(newEntityWeightsFile(label));
    generated.set(key, bytes);
  }
  return bytes;
}

/** 形式 6 の方策に渡す値を、AI の座席と同じ道で作る。 */
function extrasOf(match: Match, seat: Player): () => DecisionExtras {
  return () => botExtrasFor(match, seat, viewFor(match, seat));
}

/** 候補が 2 つ以上ある局面まで、先頭の合法手で進める。 */
function matchWithChoice(): Match {
  ensureCards();
  const match = newMatch("bots-choice");
  while (legalMoves(match.state).length < 2) {
    const mover = toMove(match);
    if (mover === null) throw new Error("候補が 2 つ以上ある局面が来なかった");
    submitMove(match, mover, match.version, legalMoves(match.state)[0] as Move, 0);
  }
  return match;
}

describe("重みから作る AI", () => {
  it("形式 5 の重みを読み、どの重みかを記録できる形で持つ", () => {
    ensureCards();
    const bytes = generationZero();
    const bot = botFromBytes("g0", bytes);
    expect(bot.identity).toEqual({
      name: "g0",
      label: "test-bot",
      generation: 0,
      weightsSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("手は方策の確率どおりに引く。世代 0 は全候補が同じ確率である", () => {
    const match = matchWithChoice();
    const seat = toMove(match)!;
    const legal = legalMoves(match.state);
    const pick = (uniform: number) =>
      botFromBytes("g0", generationZero(), () => uniform).choose(
        viewFor(match, seat),
        legal,
        NO_KNOWLEDGE,
        extrasOf(match, seat),
      );
    expect(pick(0)).toBe(0);
    expect(pick(0.999_999)).toBe(legal.length - 1);
    expect(pick(1.5 / legal.length)).toBe(1);
  });

  it("伏せたカードの知識を使うかは、重みの見出しに従う", () => {
    ensureCards();
    expect(botFromBytes("g0", generationZero()).tracksKnowledge).toBe(false);
    expect(botFromBytes("g0", generationZero("test-bot", "tracked")).tracksKnowledge).toBe(true);
  });

  it("形式 6 の重みを読み、導出値と記憶を渡すと手を引く", () => {
    const match = matchWithChoice();
    const seat = toMove(match)!;
    const legal = legalMoves(match.state);
    const bytes = entityGenerationZero();
    const bot = botFromBytes("e0", bytes, () => 0.999_999);
    expect(bot.identity).toEqual({
      name: "e0",
      label: "test-entity",
      generation: 0,
      weightsSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(bot.tracksKnowledge).toBe(true);
    const view = viewFor(match, seat);
    expect(bot.choose(view, legal, NO_KNOWLEDGE, extrasOf(match, seat))).toBe(legal.length - 1);
  });

  it("形式 6 の重みの語彙がいまのエンジンと違えば読まない", () => {
    ensureCards();
    const file = newEntityWeightsFile("test-entity");
    // 長さを変えずに 1 語だけ差し替える。長さが変われば表の形も変わり、語彙を見る前に読めなくなる。
    const vocabulary = {
      ...file.vocabulary,
      token: [...file.vocabulary.token.slice(0, -1), "無い語"],
    };
    const bytes = encodeEntityWeights({ ...file, vocabulary });
    expect(() => botFromBytes("e0", bytes)).toThrow();
  });

  it("重みでないバイト列は読まない", () => {
    expect(() => botFromBytes("x", new TextEncoder().encode("not weights"))).toThrow();
  });
});

describe("AI に見せる候補", () => {
  /** 座席 1 に AI が就いた対戦を、main で座席 1 の候補が 2 つ以上ある局面まで、先頭の合法手で進める。 */
  function botMatchInMain(): Match {
    ensureCards();
    const match = createMatch({
      matchId: "match-bot-revisit",
      decks: legalDecks(),
      seats: [
        { playerId: "player-a", displayName: "あ", rating: 1500 },
        { playerId: "bot:g0", displayName: "AI g0", rating: null },
      ],
      seatTokens: ["token-a", "token-b"],
      spectatorToken: "token-watch",
      nowMs: 0,
      startedAt: new Date(0).toISOString(),
      seedCommitment: commitSeed("bot-revisit"),
      bot: { seat: 1, bot: botFromBytes("g0", generationZero()) },
    });
    for (;;) {
      const mover = toMove(match);
      if (mover === null) throw new Error("座席 1 が main で選ぶ局面が来なかった");
      const legal = legalMoves(match.state);
      if (mover === 1 && match.state.phase === "main" && legal.length >= 2) return match;
      submitMove(match, mover, match.version, legal[0] as Move, 0);
    }
  }

  it("同じ番で既に来た局面へ戻る手を外し、ほかの手は順を保って残す", () => {
    const match = botMatchInMain();
    const legal = legalMovesFor(match, 1)!;
    expect(botCandidates(match, legal)).toEqual(legal);

    // 番を終えない手を 1 つ選び、その行き先に既に来たことにする。同じ行き先へ進む手はどれも外れる。
    // 番を終える手の行き先は次の番の局面で、記録はそこで番ごと入れ替わる。
    const key = (move: Move) => positionKey(applyMove(match.state, move).state);
    const picked = legal.find((move) => move.type !== "EndTurn" && move.type !== "Attack");
    if (picked === undefined) throw new Error("番を終えない手が候補に無い");
    const visited = key(picked);
    match.botRevisit!.arrive(applyMove(match.state, picked).state);
    const kept = legal.filter((move) => key(move) !== visited);
    expect(kept.length).toBeGreaterThan(0);
    expect(botCandidates(match, legal)).toEqual(kept);
  });

  it("人どうしの対戦では局面を記録しない", () => {
    ensureCards();
    expect(newMatch("no-bot").botRevisit).toBeNull();
  });
});

describe("AI が握るデッキ", () => {
  it("表のデッキはどれもデッキの検査を通る", () => {
    ensureCards();
    const presets = deckPresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const { label } of presets) {
      expect(validateDeck(presetDeck(label)!), label).toEqual([]);
    }
  });

  it("表に無い名前はデッキにしない", () => {
    expect(presetDeck("そんなデッキは無い")).toBeNull();
  });
});

interface Arena {
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  accounts: AccountStore;
  finished: MatchRecord[];
}

function newArena(botDelayMs = 0): Arena {
  const registry = new MatchRegistry();
  const accounts = new AccountStore(storage.db);
  const finished: MatchRecord[] = [];
  return {
    registry,
    accounts,
    finished,
    lobby: new Lobby(registry, accounts),
    hub: new MatchHub({ registry, botDelayMs, onFinish: (record) => finished.push(record) }),
  };
}

/**
 * 人の座席の接続。合法手が届いたら先頭を指す。受け取った処理の中で指し返さず、次の番へ回す。
 * サーバは受け取った処理の中で次の配信をするので、その場で指すと処理が入れ子になる。
 */
function humanSeat(arena: Arena, seatToken: string, ended: () => void): SeatSocket {
  const socket: SeatSocket = {
    send(data) {
      const message = JSON.parse(data) as ServerMessage;
      if (message.t === "ended") {
        ended();
        return;
      }
      if (message.t !== "sync" && message.t !== "delta") return;
      const legal = message.legalMoves;
      if (legal === null || legal.length === 0) return;
      const move: ClientMessage = {
        t: "move",
        stateVersion: message.stateVersion,
        move: legal[0]!,
      };
      setTimeout(() => arena.hub.handle(socket, seatToken, move), 0);
    },
    close() {},
  };
  return socket;
}

/** AI の座席に就けて、人が指す。決着の記録を返す。 */
async function playAgainst(arena: Arena, bot: Bot): Promise<MatchRecord> {
  ensureCards();
  const { account, secret } = await arena.accounts.create("ひと", 0);
  const outcome = arena.lobby.joinBot(
    { secret, deck: presetDeck("doraparuto")! },
    account,
    bot,
    presetDeck("fudin")!,
  );
  if (!outcome.ok || !("seat" in outcome)) throw new Error("AI と対戦できなかった");
  await new Promise<void>((resolve) => {
    arena.hub.attach(humanSeat(arena, outcome.seat.seatToken, resolve), outcome.seat.seatToken);
  });
  const record = arena.finished.at(-1);
  if (record === undefined) throw new Error("記録が残っていない");
  return record;
}

/**
 * 対戦の記録を初手から指し直し、AI の座席の追跡器を別に作る。サーバが手を適用するたびに
 * イベントを食わせているかを、イベントを 1 つも取りこぼさない経路と突き合わせる。
 * 指し直しの途中の局面も返す。候補の絞り方を、サーバの局面の記録とは別に求め直すのに使う。
 */
function replayed(match: Match, seat: Player): { tracker: SeatKnowledge; states: GameState[] } {
  const tracker = new SeatKnowledge(match.decks[seat], seat);
  const created = createGame({ seed: match.seedCommitment.seed, decks: match.decks });
  tracker.observe(projectEvents(created.events, seat));
  const states = [created.state];
  for (const { move } of match.moves) {
    const applied = applyMove(states.at(-1)!, move);
    tracker.observe(projectEvents(applied.events, seat));
    states.push(applied.state);
  }
  return { tracker, states };
}

/**
 * 自己対戦が学習した方策に見せる候補を、指し直した局面から求め直す。main で候補が 2 つ以上あれば、
 * 同じ番で既に来た局面（途中の選択の局面も含む）へ戻る手を外す。すべて外れるなら全部を残す。
 */
function expectedCandidates(states: readonly GameState[], legal: readonly Move[]): Move[] {
  const now = states.at(-1)!;
  if (now.phase !== "main" || legal.length <= 1) return [...legal];
  const visited = new Set(
    states
      .filter((one) => one.turn === now.turn && one.turnPlayer === now.turnPlayer)
      .map(positionKey),
  );
  const admitted = legal.filter((move) => !visited.has(positionKey(applyMove(now, move).state)));
  return admitted.length === 0 ? [...legal] : admitted;
}

/**
 * 渡された AI の前に立ち、AI が受け取った値が自己対戦の方策が受け取るものと同じであることを確かめる。
 * 候補は同じ番で既に来た局面へ戻る手を外した合法手で、知識と記憶は、知識を使う AI には記録から
 * 求め直した値と同じもの、使わない AI には何も知らない入力が届く。導出値は AI の座席と局面で照会したものが届く。
 * `masked` は、外れた候補があった決定点の数。
 */
function watched(arena: Arena, inner: Bot): Bot & { calls: number; masked: number } {
  const bot = {
    identity: inner.identity,
    tracksKnowledge: inner.tracksKnowledge,
    calls: 0,
    masked: 0,
    choose(
      view: PlayerView,
      legal: readonly Move[],
      knowledge: HiddenKnowledge,
      extras: () => DecisionExtras,
    ): number {
      bot.calls += 1;
      const [match] = arena.registry.live();
      expect(view).toEqual(viewFor(match!, 1));
      const { tracker, states } = replayed(match!, 1);
      expect(states.at(-1)).toEqual(match!.state);
      const all = legalMovesFor(match!, 1)!;
      expect(legal).toEqual(expectedCandidates(states, all));
      if (legal.length < all.length) bot.masked += 1;
      const { derived, memory } = extras();
      expect(derived).toEqual(derivedView(match!.state, 1));
      if (inner.tracksKnowledge) {
        expect(knowledge).toEqual(tracker.snapshot(view));
        expect(memory).toEqual(tracker.memory(view));
      } else {
        expect(knowledge).toBe(NO_KNOWLEDGE);
      }
      return inner.choose(view, legal, knowledge, extras);
    },
  };
  return bot;
}

describe("AI の座席", () => {
  it("人が指すだけで、AI が残りを指して決着まで進む", async () => {
    const arena = newArena();
    const bot = watched(arena, botFromBytes("g0", generationZero()));
    const record = await playAgainst(arena, bot);

    expect(record.matchResult.kind).toBe("normal");
    expect(record.seats[1]).toMatchObject({
      playerId: "bot:g0",
      rating: null,
      bot: bot.identity,
    });
    expect(record.seats[0].bot).toBeUndefined();
    // AI の手はすべて `bot` として残り、その数は AI が選んだ回数と同じである。
    const sources = record.moves.map((move) => move.source);
    expect(sources.filter((source) => source === "bot")).toHaveLength(bot.calls);
    expect(sources.filter((source) => source === "human").length).toBeGreaterThan(0);
    expect(arena.registry.live()).toHaveLength(0);
  });

  it("伏せたカードの知識を使う AI には、対戦の初手から追った知識が届く", async () => {
    const arena = newArena();
    const bot = watched(arena, botFromBytes("g0", generationZero("test-bot", "tracked")));
    const record = await playAgainst(arena, bot);

    expect(record.matchResult.kind).toBe("normal");
    expect(bot.calls).toBeGreaterThan(0);
  });

  it("形式 6 の AI は、導出値と追跡器の記憶を受け取って決着まで指す", async () => {
    const arena = newArena();
    const bot = watched(arena, botFromBytes("e0", entityGenerationZero()));
    const arrived = vi.spyOn(RevisitTracker.prototype, "arrive");
    let match: Match | undefined;
    const record = await playAgainst(arena, {
      ...bot,
      choose: (...args) => {
        match = arena.registry.live()[0];
        return bot.choose(...args);
      },
    });
    const seen = arrived.mock.calls.map(([state]) => state);
    arrived.mockRestore();

    expect(record.matchResult.kind).toBe("normal");
    expect(record.seats[1].bot).toEqual(bot.identity);
    expect(bot.calls).toBeGreaterThan(0);
    // 局面の記録は、対戦の始まりと、どの道で適用した手のあとの局面も 1 つずつ漏らさず受け取る。
    // 同じ番で戻る手はこの対戦ではまず起きないので、候補の突き合わせだけではここの漏れを見逃す。
    expect(seen).toEqual(replayed(match!, 1).states);
  });

  it("方策が投げたら、AI の投了で終える。選んでいない手を AI の手として残さない", async () => {
    const arena = newArena();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const record = await playAgainst(arena, {
      identity: botFromBytes("g0", generationZero()).identity,
      tracksKnowledge: false,
      choose: () => {
        throw new Error("方策が投げた");
      },
    });
    errors.mockRestore();

    expect(record.matchResult).toEqual({ kind: "concede", winner: 0, conceded: 1 });
    expect(record.moves.every((move) => move.source === "human")).toBe(true);
  });

  it("人が投了したら、待っていた AI の手は指さない", async () => {
    ensureCards();
    const arena = newArena(20);
    const inner = botFromBytes("g0", generationZero());
    const bot = {
      identity: inner.identity,
      tracksKnowledge: false,
      calls: 0,
      choose: inner.choose,
    };
    bot.choose = (view, legal, knowledge, extras) => {
      bot.calls += 1;
      return inner.choose(view, legal, knowledge, extras);
    };
    const { account, secret } = await arena.accounts.create("ひと", 0);
    const outcome = arena.lobby.joinBot(
      { secret, deck: presetDeck("doraparuto")! },
      account,
      bot,
      presetDeck("fudin")!,
    );
    if (!outcome.ok || !("seat" in outcome)) throw new Error("AI と対戦できなかった");
    const socket: SeatSocket = { send() {}, close() {} };
    arena.hub.attach(socket, outcome.seat.seatToken);
    // AI の番が来るまで人が指す。AI の手は間を置いて指すので、ここではまだ待ちに入っただけである。
    const [match] = arena.registry.live();
    while (toMove(match!) === 0) {
      const move = legalMovesFor(match!, 0)![0]!;
      arena.hub.handle(socket, outcome.seat.seatToken, {
        t: "move",
        stateVersion: match!.version,
        move,
      });
    }
    expect(toMove(match!)).toBe(1);
    arena.hub.handle(socket, outcome.seat.seatToken, { t: "concede" });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(arena.finished.at(-1)?.matchResult).toEqual({
      kind: "concede",
      winner: 1,
      conceded: 0,
    });
    expect(bot.calls).toBe(0);
  });
});

describe("AI の座席を開く", () => {
  it("シェアを出さずに入った対戦で AI が先に選ぶなら、人が繋ぐ前に AI が動く", async () => {
    ensureCards();
    const arena = newArena();
    const bot = botFromBytes("g0", generationZero());
    // 準備で先に選ぶのは先攻の側なので、AI が先になる対戦を引くまで開き直す。
    let started: Match | undefined;
    let seatToken = "";
    for (let attempt = 0; attempt < 40 && started === undefined; attempt++) {
      const { account, secret } = await arena.accounts.create("ひと", 0);
      const outcome = arena.lobby.joinBot(
        { secret, deck: presetDeck("doraparuto")! },
        account,
        bot,
        presetDeck("fudin")!,
      );
      if (!outcome.ok || !("seat" in outcome)) throw new Error("AI と対戦できなかった");
      const match = arena.registry.bySeatToken(outcome.seat.seatToken)?.match;
      if (match !== undefined && toMove(match) === 1) {
        started = match;
        seatToken = outcome.seat.seatToken;
      }
    }
    if (started === undefined) throw new Error("AI が先に選ぶ対戦が来なかった");
    const version = started.version;

    arena.hub.wakeBot(seatToken);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started.version).toBeGreaterThan(version);
    expect(started.moves.at(-1)?.source).toBe("bot");
  });

  it("シェアが開くのを待っている AI との対戦も、続いている対戦として席を返す", async () => {
    ensureCards();
    const arena = newArena();
    const bot = botFromBytes("g0", generationZero());
    const { account, secret } = await arena.accounts.create("ひと", 0);
    const request = {
      secret,
      deck: presetDeck("doraparuto")!,
      seedShareCommit: commitShare("c".repeat(64)),
    };
    const first = arena.lobby.joinBot(request, account, bot, presetDeck("fudin")!);
    if (!first.ok || !("seat" in first)) throw new Error("AI と対戦できなかった");
    expect(arena.registry.live()).toHaveLength(0);
    expect(arena.lobby.refuseBot(request, account, presetDeck("fudin")!)).toMatchObject({
      ok: false,
      code: BOT_MATCH_LIVE,
      seat: first.seat,
    });
  });

  it("重みを読んでいるあいだは、同じ人の次の要求を席なしで断る", async () => {
    ensureCards();
    const arena = newArena();
    const { account, secret } = await arena.accounts.create("ひと", 0);
    const request = { secret, deck: presetDeck("doraparuto")! };
    arena.lobby.holdBotJoin(account.playerId);
    const refused = arena.lobby.refuseBot(request, account, presetDeck("fudin")!);
    expect(refused).toMatchObject({ ok: false, code: BOT_MATCH_LIVE });
    expect(refused?.ok === false && refused.seat).toBeUndefined();
    arena.lobby.releaseBotJoin(account.playerId);
    expect(arena.lobby.refuseBot(request, account, presetDeck("fudin")!)).toBeNull();
  });

  it("AI との対戦が続いているあいだは、同じ人の次の対戦を断る", async () => {
    ensureCards();
    const arena = newArena();
    const bot = botFromBytes("g0", generationZero());
    const { account, secret } = await arena.accounts.create("ひと", 0);
    const join = () =>
      arena.lobby.joinBot(
        { secret, deck: presetDeck("doraparuto")! },
        account,
        bot,
        presetDeck("fudin")!,
      );
    const first = join();
    if (!first.ok || !("seat" in first)) throw new Error("AI と対戦できなかった");
    // 断るときは、続いている対戦の席を返す。画面を失っていても、そこへ戻れる。
    expect(join()).toMatchObject({ ok: false, code: BOT_MATCH_LIVE, seat: first.seat });
    expect(arena.registry.live()).toHaveLength(1);

    // 決着が付いた対戦は、レジストリに残っていても数えない。
    const [match] = arena.registry.live();
    match!.result = { kind: "concede", winner: 1, conceded: 0 };
    expect(join().ok).toBe(true);
  });
});

describe("重みの保存先", () => {
  it("同じ重みは作り直さず、置き換えた重みは読み直す", async () => {
    ensureCards();
    const store = new BotStore(storage.archive);
    await storage.archive.put(`${BOT_PREFIX}same`, generationZero("first"));
    const first = await store.load("same");
    const again = await store.load("same");
    expect(first.ok && again.ok && first.bot === again.bot).toBe(true);

    await storage.archive.put(`${BOT_PREFIX}same`, generationZero("second"));
    const replaced = await store.load("same");
    expect(replaced.ok && replaced.bot.identity.label).toBe("second");
  });

  it("キャッシュから落ちても、生きている対戦が持っている AI は作り直さない", async () => {
    ensureCards();
    const store = new BotStore(storage.archive);
    const names = ["keep-a", "keep-b", "keep-c", "keep-d", "keep-e"];
    for (const name of names)
      await storage.archive.put(`${BOT_PREFIX}${name}`, generationZero(name));
    const held = await store.load("keep-a");
    // キャッシュは 4 本なので、残りの 4 本を読むと最初の 1 本はキャッシュから落ちる。
    for (const name of names.slice(1)) await store.load(name);
    const again = await store.load("keep-a");
    expect(held.ok && again.ok && held.bot === again.bot).toBe(true);
  });

  it("名前の形が違うものと、置いていないものは断る", async () => {
    const store = new BotStore(storage.archive);
    expect((await store.load("../matches/x")).ok).toBe(false);
    expect((await store.load("not-there")).ok).toBe(false);
  });
});

describe("AI との対戦の記録", () => {
  it("索引に行は足すが、人のレーティングと戦績は動かさない", async () => {
    const arena = newArena();
    const archive = new MatchArchive(storage.db, storage.archive, arena.accounts);
    const record = await playAgainst(arena, botFromBytes("g0", generationZero()));
    await archive.settle(record);

    const row = await storage.db
      .prepare("SELECT rating, games FROM players WHERE player_id = ?")
      .bind(record.seats[0].playerId)
      .first<{ rating: number; games: number }>();
    expect(row).toEqual({ rating: INITIAL_RATING, games: 0 });
    const listed = await archive.list(record.seats[0].playerId);
    expect(listed.map((summary) => summary.matchId)).toContain(record.matchId);
    expect(listed.find((summary) => summary.matchId === record.matchId)?.opponentName).toBe(
      "AI g0",
    );
  });
});
