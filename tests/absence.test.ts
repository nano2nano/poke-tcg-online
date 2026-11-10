/**
 * 持ち時間は無く、手を持ったまま対戦を放置した座席だけが時間切れになる
 * （`docs/spec/battle-server.md` 3.4 節）。
 */

import { describe, expect, it } from "vitest";
import { botFromBytes } from "../src/bots.js";
import {
  encodePpoWeights,
  legalMoves,
  newPpoWeightsFile,
  opponent,
  type Player,
} from "../src/engine.js";
import { commitSeed } from "../src/fingerprint.js";
import { ABSENCE_LIMIT_MS, IDLE_LIMIT_MS, MatchHub, type SeatSocket } from "../src/hub.js";
import { createMatch, submitMove, toMove, type Match } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, legalDecks, newMatch } from "./helpers.js";

const socket = (): SeatSocket => ({ send() {}, close() {} });

function arena(match: Match) {
  const registry = new MatchRegistry();
  registry.add(match);
  const clock = { now: 0 };
  const hub = new MatchHub({ registry, now: () => clock.now, botDelayMs: 60 * 60_000 });
  const sockets = [socket(), socket()] as const;
  const attach = (seat: Player) => hub.attach(sockets[seat], match.seatTokens[seat]);
  const sweepAt = (nowMs: number) => {
    clock.now = nowMs;
    hub.sweepTimeouts();
  };
  return { hub, clock, sockets, attach, sweepAt };
}

describe("放置された対戦", () => {
  it("繋いでいる座席は、離れた座席の期限を過ぎても時間切れにならない", () => {
    ensureCards();
    const match = newMatch("absence-1");
    const mover = toMove(match) as Player;
    const { attach, sweepAt } = arena(match);
    attach(mover);
    sweepAt(IDLE_LIMIT_MS - 1);
    expect(match.result).toBeNull();
    // 画面を開いたまま忘れられた対戦は、ここで終わる。
    sweepAt(IDLE_LIMIT_MS);
    expect(match.result).toEqual({ kind: "timeout", winner: opponent(mover), timedOut: mover });
  });

  it("手を持つ座席が離れたまま期限を過ぎたら、その座席の負けで終える", () => {
    ensureCards();
    const match = newMatch("absence-2");
    const mover = toMove(match) as Player;
    const { hub, clock, sockets, attach, sweepAt } = arena(match);
    attach(mover);
    // 離れるまでに考えていた時間は数えない。
    const leftAt = 3 * ABSENCE_LIMIT_MS;
    clock.now = leftAt;
    hub.detach(sockets[mover]);

    sweepAt(leftAt + ABSENCE_LIMIT_MS - 1);
    expect(match.result).toBeNull();
    sweepAt(leftAt + ABSENCE_LIMIT_MS);
    expect(match.result).toEqual({ kind: "timeout", winner: opponent(mover), timedOut: mover });
    expect(match.moves).toHaveLength(0);
  });

  it("一度も繋がなかった座席は、手を持った時刻から数える", () => {
    ensureCards();
    const match = newMatch("absence-3");
    const mover = toMove(match) as Player;
    const { sweepAt } = arena(match);
    sweepAt(ABSENCE_LIMIT_MS - 1);
    expect(match.result).toBeNull();
    sweepAt(ABSENCE_LIMIT_MS);
    expect(match.result).toMatchObject({ kind: "timeout", timedOut: mover });
  });

  it("戻ってくれば、次に離れたときは数え直す", () => {
    ensureCards();
    const match = newMatch("absence-4");
    const mover = toMove(match) as Player;
    const { hub, clock, sockets, attach, sweepAt } = arena(match);
    attach(mover);
    hub.detach(sockets[mover]);
    clock.now = ABSENCE_LIMIT_MS - 1;
    attach(mover);
    hub.detach(sockets[mover]);

    sweepAt(2 * ABSENCE_LIMIT_MS - 2);
    expect(match.result).toBeNull();
    sweepAt(2 * ABSENCE_LIMIT_MS - 1);
    expect(match.result).not.toBeNull();
  });

  it("相手の番のあいだに離れていた時間は数えない", () => {
    ensureCards();
    const match = newMatch("absence-5");
    const { hub, clock, sockets, attach, sweepAt } = arena(match);
    attach(0);
    attach(1);
    // 離れた座席に手が回るまで、繋いでいる座席が長く考えながら指す。
    const first = toMove(match) as Player;
    const waiting = opponent(first);
    hub.detach(sockets[waiting]);
    const movedAt = 5 * ABSENCE_LIMIT_MS;
    clock.now = movedAt;
    while (toMove(match) === first) {
      const [move] = legalMoves(match.state);
      if (move === undefined) throw new Error("指せる手が無い");
      expect(submitMove(match, first, match.version, move, movedAt).ok).toBe(true);
    }
    expect(toMove(match)).toBe(waiting);

    sweepAt(movedAt + ABSENCE_LIMIT_MS - 1);
    expect(match.result).toBeNull();
    sweepAt(movedAt + ABSENCE_LIMIT_MS);
    expect(match.result).toMatchObject({ kind: "timeout", timedOut: waiting });
  });

  it("AI の座席は接続を持たないが、離れた座席としては数えない", () => {
    const bot = botFromBytes("g0", encodePpoWeights(newPpoWeightsFile("test-bot")));
    // 先攻を変えて、AI が先に手を持つ対戦を探す。
    const match = ([0, 1] as Player[])
      .map((firstPlayer) =>
        createMatch({
          matchId: `absence-bot-${firstPlayer}`,
          decks: legalDecks(),
          seats: [
            { playerId: "player-a", displayName: "あ", rating: 1500 },
            { playerId: "bot", displayName: "AI", rating: null, bot: bot.identity },
          ],
          seatTokens: [`token-a-${firstPlayer}`, `token-b-${firstPlayer}`],
          spectatorToken: `token-watch-${firstPlayer}`,
          nowMs: 0,
          startedAt: new Date(0).toISOString(),
          seedCommitment: commitSeed("absence-bot"),
          bots: [null, bot],
          firstPlayer,
        }),
      )
      .find((candidate) => toMove(candidate) === 1);
    if (match === undefined) throw new Error("AI が先に手を持つ対戦を作れなかった");
    const { sweepAt } = arena(match);
    sweepAt(IDLE_LIMIT_MS - 1);
    expect(match.result).toBeNull();
  });
});
