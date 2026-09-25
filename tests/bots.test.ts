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
import { commitShare } from "../src/fingerprint.js";
import {
  applyMove,
  createGame,
  encodePpoWeights,
  legalMoves,
  newPpoWeightsFile,
  NO_KNOWLEDGE,
  projectEvents,
  SeatKnowledge,
  type HiddenKnowledge,
  type Move,
  type Player,
  type PlayerView,
} from "../src/engine.js";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { BOT_MATCH_LIVE, Lobby } from "../src/lobby.js";
import type { MatchRecord } from "../src/log.js";
import { legalMovesFor, submitMove, toMove, viewFor, type Match } from "../src/match.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, newMatch } from "./helpers.js";
import { startStorage } from "./worker.js";

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

  it("重みでないバイト列は読まない", () => {
    expect(() => botFromBytes("x", new TextEncoder().encode("not weights"))).toThrow();
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
 * 対戦の記録を初手から指し直し、AI の座席の追跡器を別に作って知識を求める。
 * サーバが手を適用するたびにイベントを食わせているかを、イベントを 1 つも取りこぼさない経路と突き合わせる。
 */
function replayedKnowledge(match: Match, seat: Player, view: PlayerView): HiddenKnowledge {
  const tracker = new SeatKnowledge(match.decks[seat], seat);
  const created = createGame({ seed: match.seedCommitment.seed, decks: match.decks });
  tracker.observe(projectEvents(created.events, seat));
  let state = created.state;
  for (const { move } of match.moves) {
    const applied = applyMove(state, move);
    tracker.observe(projectEvents(applied.events, seat));
    state = applied.state;
  }
  return tracker.snapshot(view);
}

/**
 * 渡された AI の前に立ち、AI が受け取った値が座席の射影と合法手そのものであることを確かめる。
 * 知識は、知識を使う AI には記録から求め直した値と同じもの、使わない AI には何も知らない入力が届く。
 */
function watched(arena: Arena, inner: Bot): Bot & { calls: number } {
  const bot = {
    identity: inner.identity,
    tracksKnowledge: inner.tracksKnowledge,
    calls: 0,
    choose(view: PlayerView, legal: readonly Move[], knowledge: HiddenKnowledge): number {
      bot.calls += 1;
      const [match] = arena.registry.live();
      expect(view).toEqual(viewFor(match!, 1));
      expect(legal).toEqual(legalMovesFor(match!, 1));
      if (inner.tracksKnowledge) {
        expect(knowledge).toEqual(replayedKnowledge(match!, 1, view));
      } else {
        expect(knowledge).toBe(NO_KNOWLEDGE);
      }
      return inner.choose(view, legal, knowledge);
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
    bot.choose = (view, legal, knowledge) => {
      bot.calls += 1;
      return inner.choose(view, legal, knowledge);
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
    // 重みを 5 本、1 本ずつ方策にする（世代 0 は初期値との照合も含む）ので、既定の 5 秒では足りない。
  }, 30_000);

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
