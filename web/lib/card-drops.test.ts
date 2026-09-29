import { describe, expect, it } from "vitest";
import { legalMoves, type Move, type PlayerView } from "../../src/engine.js";
import { toMove, viewFor, type Match } from "../../src/match.js";
import { ensureCards, finishSetup, newMatch } from "../../tests/helpers.js";
import { BENCH_SPOT, PLAY_SPOT, planDrops, pokemonSpot } from "./card-drops.js";

/** 準備を終え、最初の番の手を持つ座席から見た盤面と、その手。 */
function firstTurn(): { match: Match; view: PlayerView; moves: Move[] } {
  ensureCards();
  const match = newMatch("card-drops");
  finishSetup(match);
  const mover = toMove(match)!;
  return { match, view: viewFor(match, mover), moves: legalMoves(match.state) };
}

const keyOf = (move: Move) => JSON.stringify(move);

describe("planDrops", () => {
  it("手札のカードを使う手を、カードの種類と落とす先で引ける", () => {
    const { view, moves } = firstTurn();
    const plan = planDrops(
      moves.map((move) => ({ move, key: keyOf(move) })),
      { view, cards: {} },
    );
    const hand = new Map(
      ("hand" in view.self ? view.self.hand : []).map((card) => [card.instanceId, card.defId]),
    );
    let checked = 0;
    for (const move of moves) {
      const spot =
        move.type === "PlayBasic"
          ? BENCH_SPOT
          : move.type === "AttachEnergy" || move.type === "Evolve" || move.type === "AttachTool"
            ? pokemonSpot(move.target)
            : move.type === "PlayTrainer"
              ? PLAY_SPOT
              : null;
      if (spot === null || !("cardInstanceId" in move)) continue;
      expect(plan.get(hand.get(move.cardInstanceId)!)?.get(spot)).toContain(keyOf(move));
      checked += 1;
    }
    // 番の初めには、少なくともエネルギーをつける手かベンチに出す手がある。
    expect(checked).toBeGreaterThan(0);
  });

  it("手札のカードを使わない手は、表に入れない", () => {
    const { view, moves } = firstTurn();
    const others = moves.filter((move) => move.type === "EndTurn" || move.type === "Attack");
    expect(others.length).toBeGreaterThan(0);
    const plan = planDrops(
      others.map((move) => ({ move, key: keyOf(move) })),
      { view, cards: {} },
    );
    expect(plan.size).toBe(0);
  });

  it("相手の手札のカードを使う手は、表に入れない", () => {
    const { match, view, moves } = firstTurn();
    const mover = toMove(match)!;
    const other = viewFor(match, mover === 0 ? 1 : 0);
    const plan = planDrops(
      moves.map((move) => ({ move, key: keyOf(move) })),
      { view: other, cards: {} },
    );
    expect(view.viewer).not.toBe(other.viewer);
    expect(plan.size).toBe(0);
  });
});
