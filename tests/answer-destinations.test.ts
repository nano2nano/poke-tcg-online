/**
 * 効果の選択への答えで、選んだカードがどこへ行くか（`docs/spec/battle-server.md` 3.2 節の
 * `answerDestinations`）。
 *
 * カードの識別子を書かないので、当てはまるトレーナーズはカードプールから動かして探す。
 */

import { describe, expect, it } from "vitest";
import {
  applyMove,
  classifyDefId,
  legalMoves,
  loadGeneratedCards,
  type CardDefId,
  type GameState,
  type Move,
  type Player,
} from "../src/engine.js";
import { commitSeed } from "../src/fingerprint.js";
import {
  answerDestinationsFor,
  answerDestinationsOf,
  createMatch,
  submitMove,
  toMove,
  type AnswerDestination,
  type Match,
} from "../src/match.js";
import { ensureCards, legalDecks, newMatch, playToEnd } from "./helpers.js";

interface Played {
  match: Match;
  seat: Player;
}

/** 違うタイプの基本エネルギーを 2 種類。「それぞれちがうタイプ」を選ぶ効果が 2 枚目を選べるように。 */
function twoBasicEnergies(): [CardDefId, CardDefId] {
  const energies = [...loadGeneratedCards()]
    .filter((def) => def.kind === "energy" && def.basic)
    .sort((a, b) => (a.defId < b.defId ? -1 : 1));
  const first = energies[0];
  const second = energies.find(
    (def) =>
      def.kind === "energy" && first?.kind === "energy" && def.energyType !== first.energyType,
  );
  if (first === undefined || second === undefined) throw new Error("基本エネルギーが 2 種類無い");
  return [first.defId, second.defId];
}

/** 山札の多くをそのトレーナーズにして、最初に使える番で使ったところ。使えなければ null。 */
function afterPlaying(trainer: CardDefId): Played | null {
  const [deck] = legalDecks();
  const [energyA, energyB] = twoBasicEnergies();
  const basics = deck.cards.slice(0, 12);
  const cards = [...basics];
  while (cards.length < 36) cards.push(trainer);
  while (cards.length < 48) cards.push(energyA);
  while (cards.length < 60) cards.push(energyB);
  const match = createMatch({
    matchId: `destination-${trainer}`,
    decks: [{ cards }, { cards }],
    seats: [
      { playerId: "player-a", displayName: "あ", rating: 1500 },
      { playerId: "player-b", displayName: "い", rating: 1500 },
    ],
    seatTokens: ["token-a", "token-b"],
    spectatorToken: "token-watch",
    nowMs: 0,
    startedAt: new Date(0).toISOString(),
    seedCommitment: commitSeed(`destination-${trainer}`),
  });
  for (let step = 0; step < 200; step++) {
    const seat = toMove(match);
    if (seat === null) return null;
    const legal = legalMoves(match.state);
    const hand = match.state.players[seat].hand;
    const play = legal.find(
      (move) =>
        move.type === "PlayTrainer" &&
        hand.find((card) => card.instanceId === move.cardInstanceId)?.defId === trainer,
    );
    if (play !== undefined) {
      submitMove(match, seat, match.version, play, 0);
      return { match, seat };
    }
    const next = legal.find((move) => move.type === "EndTurn") ?? (legal[0] as Move);
    submitMove(match, seat, match.version, next, 0);
  }
  return null;
}

/** 効果の選択が続くあいだ、辞退でない先頭の答えで答え続け、選択ごとの行き先を集める。 */
function walk({ match, seat }: Played, onStep?: (played: Played) => void): AnswerDestination[][] {
  const steps: AnswerDestination[][] = [];
  while (match.state.choices.at(-1)?.owner === seat) {
    onStep?.({ match, seat });
    const destinations = answerDestinationsFor(match, seat) ?? [];
    steps.push(destinations.filter((each) => each !== null));
    const answer = legalMoves(match.state).find(
      (move) => move.type === "AnswerChoice" && move.answer.kind !== "decline",
    );
    if (answer === undefined) break;
    submitMove(match, seat, match.version, answer, 0);
  }
  return steps;
}

/** 手札に加える選択のすぐあとに、ポケモンにつける選択が続くトレーナーズ。 */
function handThenAttach(): CardDefId {
  ensureCards();
  const found = [...loadGeneratedCards()]
    .filter(
      (def) =>
        def.kind === "trainer" &&
        (def.trainerKind === "supporter" || def.trainerKind === "item") &&
        classifyDefId(def.defId) === "implemented",
    )
    .map((def) => def.defId)
    .sort()
    .find((trainer) => {
      const played = afterPlaying(trainer);
      if (played === null) return false;
      const steps = walk(played);
      return steps.some(
        (step, index) =>
          step.length > 0 &&
          step.every((each) => each.to === "hand") &&
          (steps[index + 1] ?? []).some((each) => each.to === "attached"),
      );
    });
  if (found === undefined) throw new Error("条件に合うトレーナーズが見つからない");
  return found;
}

function countOf(defIds: readonly CardDefId[], defId: CardDefId): number {
  return defIds.filter((each) => each === defId).length;
}

function attachedTo(state: GameState, seat: Player, target: string): CardDefId[] {
  const side = state.players[seat];
  const pokemon = [side.active, ...side.bench].find((each) => each?.inPlayId === target);
  return pokemon?.attached.map((card) => card.defId) ?? [];
}

/** 座席のカードがどのゾーンに何枚あるか。公開しただけの答えでは変わらない。 */
function zoneSizes(state: GameState, seat: Player): number[] {
  const side = state.players[seat];
  const inPlay = [side.active, ...side.bench].flatMap((each) =>
    each === null ? [] : [...each.stack, ...each.attached],
  );
  return [side.hand.length, side.deck.length, side.discard.length, inPlay.length];
}

/** 出した行き先が、その答えを実際に適用した結果と合うか。 */
function expectDestinationHolds(match: Match, seat: Player): number {
  const legal = legalMoves(match.state);
  const destinations = answerDestinationsFor(match, seat);
  if (destinations === null) return 0;
  expect(destinations).toHaveLength(legal.length);
  let checked = 0;
  legal.forEach((move, index) => {
    const destination = destinations[index];
    if (destination == null || move.type !== "AnswerChoice") return;
    const answer = move.answer;
    const after = applyMove(match.state, move).state;
    checked += 1;
    switch (destination.to) {
      case "hand": {
        if (answer.kind !== "cardDef") throw new Error("山札から選ぶ答えではない");
        const hand = (state: GameState) => state.players[seat].hand.map((card) => card.defId);
        expect(countOf(hand(after), answer.defId)).toBe(
          countOf(hand(match.state), answer.defId) + 1,
        );
        break;
      }
      case "attached": {
        if (answer.kind !== "inPlay") throw new Error("ポケモンを選ぶ答えではない");
        expect(destination.target).toBe(answer.target);
        const [card] = destination.cards;
        if (card === undefined) throw new Error("つけるカードが無い");
        expect(countOf(attachedTo(after, seat, answer.target), card)).toBe(
          countOf(attachedTo(match.state, seat, answer.target), card) + 1,
        );
        break;
      }
      case "revealed":
        expect(zoneSizes(after, seat)).toEqual(zoneSizes(match.state, seat));
        break;
      default:
        throw new Error(`この効果で出るとは思っていない行き先: ${destination.to}`);
    }
  });
  return checked;
}

describe("効果の選択で選んだカードの行き先", () => {
  it("手札に加える答えとポケモンにつける答えを見分け、どちらも実際の行き先と合う", () => {
    const played = afterPlaying(handThenAttach()) as Played;
    let checked = 0;
    const steps = walk(played, ({ match, seat }) => {
      checked += expectDestinationHolds(match, seat);
      // 選んでいるのは手番の座席だけで、相手には出さない。
      expect(answerDestinationsFor(match, (1 - seat) as Player)).toBeNull();
    });
    const kinds = steps.map((step) => [...new Set(step.map((each) => each.to))]);
    expect(kinds).toContainEqual(["hand"]);
    expect(kinds).toContainEqual(["attached"]);
    expect(checked).toBeGreaterThanOrEqual(2);
    // 効果を終えたら出さない。
    expect(answerDestinationsFor(played.match, played.seat)).toBeNull();
  });

  it("ポケモンにつくカードは、この効果で山札から見せたものでなければ名前を渡さない", () => {
    const played = afterPlaying(handThenAttach()) as Played;
    let checked = false;
    walk(played, ({ match, seat }) => {
      const attaching = (answerDestinationsFor(match, seat) ?? []).some(
        (each) => each?.to === "attached",
      );
      if (!attaching) return;
      // 見せた記録が無い局面では、つくカードは座席に見えない山札のどれかでしかない。
      expect(answerDestinationsOf(match.state, null)).toBeNull();
      checked = true;
    });
    expect(checked).toBe(true);
  });

  it("効果の出どころを持たない選択（対戦準備など）と、選択の無い局面では出さない", () => {
    const shown: (AnswerDestination | null)[][] = [];
    playToEnd(newMatch("answer-destinations-none"), 7, {
      maxMoves: 400,
      inspect: (match, seat) => {
        if (match.state.choices.at(-1)?.source != null) return;
        const destinations = answerDestinationsFor(match, seat);
        if (destinations !== null) shown.push(destinations);
      },
    });
    expect(shown).toEqual([]);
  });
});
