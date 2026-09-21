/** 手の受理と決着（`docs/spec/battle-server.md` 2 節）。 */

import { describe, expect, it } from "vitest";
import { legalMoves, type Move, type Player } from "../src/engine.js";
import { MOVE_ALLOWANCE_MS } from "../src/clock.js";
import { applyTimeout, concede, engineOutcome, submitMove, toMove } from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

function firstLegal(match: ReturnType<typeof newMatch>): Move {
  return legalMoves(match.state)[0] as Move;
}

describe("手の受理", () => {
  it("手番でない座席の手を弾き、局面を動かさない", () => {
    ensureCards();
    const match = newMatch("submit-1");
    const mover = toMove(match) as Player;
    const other = (1 - mover) as Player;
    const before = match.version;
    expect(submitMove(match, other, match.version, firstLegal(match), 0)).toEqual({
      ok: false,
      reason: "not-your-turn",
    });
    expect(match.version).toBe(before);
  });

  it("古い stateVersion の手を弾く（二重送信と古い画面を同じ仕組みで止める）", () => {
    ensureCards();
    const match = newMatch("submit-2");
    const mover = toMove(match) as Player;
    const move = firstLegal(match);
    expect(submitMove(match, mover, match.version, move, 0).ok).toBe(true);
    // 同じ手をもう一度、古い版番号で送る。
    expect(submitMove(match, toMove(match) as Player, match.version - 1, move, 0)).toEqual({
      ok: false,
      reason: "stale-version",
    });
  });

  it("合法手に無い手を弾き、対戦を終わらせない", () => {
    ensureCards();
    const match = newMatch("submit-3");
    const mover = toMove(match) as Player;
    const bogus: Move = { type: "EndTurn", player: mover };
    const outcome = submitMove(match, mover, match.version, bogus, 0);
    expect(outcome).toEqual({ ok: false, reason: "illegal-move" });
    expect(match.result).toBeNull();
    expect(toMove(match)).toBe(mover);
  });

  it("1 手ごとに版番号が 1 増え、思考時間が記録される", () => {
    ensureCards();
    const match = newMatch("submit-4", 1_000);
    const mover = toMove(match) as Player;
    submitMove(match, mover, match.version, firstLegal(match), 4_500);
    expect(match.version).toBe(1);
    expect(match.moves).toHaveLength(1);
    expect(match.moves[0]?.elapsedMs).toBe(3_500);
    expect(match.moves[0]?.source).toBe("human");
  });
});

describe("決着", () => {
  it("最後まで指すと勝敗が付き、エンジンの outcome と一致する", () => {
    ensureCards();
    const played = playToEnd(newMatch("finish-1"), 4242);
    expect(played.finished).toBe(true);
    expect(played.match.result?.kind).toBe("normal");
    const outcome = engineOutcome(played.match);
    expect(outcome).not.toBeNull();
    if (played.match.result?.kind === "normal") {
      expect(played.match.result.winner).toBe(outcome?.winner ?? null);
    }
  });

  it("投了は局面を動かさず、エンジンの outcome を付けない", () => {
    ensureCards();
    const match = newMatch("finish-2");
    const version = match.version;
    expect(concede(match, 0, 5_000)).toBe(true);
    expect(match.result).toEqual({ kind: "concede", winner: 1, conceded: 0 });
    expect(engineOutcome(match)).toBeNull();
    expect(match.version).toBe(version);
    expect(toMove(match)).toBeNull();
  });

  it("持ち時間が尽きた座席の負けにし、自動の手を指さない", () => {
    ensureCards();
    const match = newMatch("finish-3");
    const mover = toMove(match) as Player;
    expect(applyTimeout(match, MOVE_ALLOWANCE_MS)).toBe(false);
    const overrun = MOVE_ALLOWANCE_MS + match.clocks[mover].bankMs;
    expect(applyTimeout(match, overrun)).toBe(true);
    expect(match.result).toEqual({
      kind: "timeout",
      winner: 1 - mover,
      timedOut: mover,
    });
    expect(match.moves).toHaveLength(0);
  });

  it("決着したあとは手を受け付けない", () => {
    ensureCards();
    const match = newMatch("finish-4");
    concede(match, 0, 0);
    expect(submitMove(match, 1, match.version, firstLegal(match), 0)).toEqual({
      ok: false,
      reason: "match-over",
    });
  });
});
