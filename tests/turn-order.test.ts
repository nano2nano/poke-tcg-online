/**
 * 先攻と後攻は、コイントスに勝った座席が選ぶ（`docs/spec/battle-server.md` 2.5 節）。
 *
 * 選ぶのは対戦が始まる前で、手札もまだ無い。選んだ先攻は再生の入力になる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { botFromBytes } from "../src/bots.js";
import { encodePpoWeights, newPpoWeightsFile, opponent, type Player } from "../src/engine.js";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { Lobby, type Seated } from "../src/lobby.js";
import { BANK_MS, MOVE_ALLOWANCE_MS } from "../src/clock.js";
import type { ServerMessage } from "../src/protocol.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { startStorage } from "./worker.js";

let storage: Awaited<ReturnType<typeof startStorage>>;

beforeAll(async () => {
  ensureCards();
  storage = await startStorage();
});

afterAll(async () => {
  await storage.close();
});

function recorder(): SeatSocket & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    send(data: string) {
      sent.push(JSON.parse(data) as ServerMessage);
    },
    close() {},
  };
}

function newArena() {
  const registry = new MatchRegistry();
  const accounts = new AccountStore(storage.db);
  const clock = { now: 0 };
  const lobby = new Lobby(registry, accounts, () => clock.now);
  const hub = new MatchHub({ registry, now: () => clock.now, botDelayMs: 60_000 });
  return { registry, accounts, clock, lobby, hub };
}

type Arena = ReturnType<typeof newArena>;

/** 2 人を同じルームコードで入れ、両方の席に繋ぐ。シェアを出さないので、席が決まった時点でコイントスが済んでいる。 */
async function seatBoth(arena: Arena) {
  const join = async (name: string) => {
    const { account, secret } = await arena.accounts.create(name, 0);
    return arena.lobby.join({ secret, deck: legalDecks()[0], roomCode: "へや" }, account);
  };
  const first = await join("a");
  const second = await join("b");
  if (!first.ok || !second.ok || !("seat" in second)) throw new Error("席が決まっていない");
  const claimed = arena.lobby.claim(first.ticket);
  if (claimed.kind !== "seated") throw new Error(`席が取れていない: ${claimed.kind}`);
  const seats: [Seated, Seated] = [claimed.seat, second.seat];
  const sockets = [recorder(), recorder()] as const;
  for (const seat of [0, 1] as Player[]) arena.hub.attach(sockets[seat], seats[seat].seatToken);
  const winner = arena.registry.pendingBySeatToken(seats[0].seatToken)?.pending.toss?.winner;
  if (winner === undefined) throw new Error("コイントスが済んでいない");
  return { seats, sockets, winner };
}

describe("先攻と後攻を選ぶ", () => {
  it("コイントスに勝った座席だけが選べ、選んだ先攻で始まる", async () => {
    const arena = newArena();
    const { seats, sockets, winner } = await seatBoth(arena);
    const loser = opponent(winner);
    // 両座席に勝った座席が届き、局面はまだ届かない。
    for (const socket of sockets) expect(socket.sent).toEqual([{ t: "pending", toss: winner }]);

    arena.hub.handle(sockets[loser], seats[loser].seatToken, { t: "turn-order", first: true });
    expect(sockets[loser].sent.at(-1)?.t).toBe("error");
    expect(arena.registry.live()).toHaveLength(0);

    // 選ぶのに使った時間は、ふだんの 1 手と同じく、1 手の猶予を越えたぶんが勝った座席の持ち時間から減る。
    arena.clock.now = MOVE_ALLOWANCE_MS + 5_000;
    arena.hub.handle(sockets[winner], seats[winner].seatToken, { t: "turn-order", first: false });
    const [match] = arena.registry.live();
    expect(match?.firstPlayer).toBe(loser);
    expect(match?.clocks[winner].bankMs).toBe(BANK_MS - 5_000);
    expect(match?.clocks[loser].bankMs).toBe(BANK_MS);
    for (const socket of sockets) {
      expect(socket.sent.at(-1)).toMatchObject({ t: "sync", firstPlayer: loser });
    }

    // 決まったあとに選び直すことはできない。
    arena.hub.handle(sockets[winner], seats[winner].seatToken, { t: "turn-order", first: true });
    expect(sockets[winner].sent.at(-1)?.t).toBe("error");
    expect(match?.firstPlayer).toBe(loser);
  });

  it("勝った座席の持ち時間が尽きるまで選ばなければ、その座席を先攻にして始める", async () => {
    const arena = newArena();
    const { sockets, winner } = await seatBoth(arena);
    const deadline = MOVE_ALLOWANCE_MS + BANK_MS;

    arena.clock.now = deadline - 1;
    arena.hub.sweepTimeouts();
    expect(arena.registry.live()).toHaveLength(0);

    arena.clock.now = deadline;
    arena.hub.sweepTimeouts();
    const [match] = arena.registry.live();
    expect(match?.firstPlayer).toBe(winner);
    expect(match?.clocks[winner].bankMs).toBe(0);
    expect(sockets[0].sent.at(-1)).toMatchObject({ t: "sync", firstPlayer: winner });
  });

  // 開き直すたびに対戦を作るので、既定の 5 秒では足りないことがある。
  it("AI がコイントスに勝ったら、後攻を選んでその場で始まる", { timeout: 30_000 }, async () => {
    const arena = newArena();
    const bot = botFromBytes("g0", encodePpoWeights(newPpoWeightsFile("test-bot")));
    const [deck, botDeck] = legalDecks();
    const seen = new Set<Player>();
    // どちらが勝つかは seed で決まる。両方を見るまで開き直す。
    for (let attempt = 0; attempt < 40 && seen.size < 2; attempt++) {
      const { account, secret } = await arena.accounts.create("ひと", 0);
      const joined = arena.lobby.joinBot({ secret, deck }, account, bot, botDeck);
      if (!joined.ok || !("seat" in joined)) throw new Error("AI と対戦できなかった");
      const { seatToken } = joined.seat;
      const pending = arena.registry.pendingBySeatToken(seatToken)?.pending;
      if (pending !== undefined) {
        // 人が勝てば、人が選ぶまで始まらない。
        expect(pending.toss?.winner).toBe(0);
        seen.add(0);
        continue;
      }
      expect(arena.registry.bySeatToken(seatToken)?.match.firstPlayer).toBe(0);
      seen.add(1);
    }
    expect(seen).toEqual(new Set([0, 1]));
  });
});
