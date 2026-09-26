/**
 * 選んだカードを山札の端へ順に置く選択で、今選ぶカードがどこへ入るか（`docs/spec/battle-server.md` 3.2 節の
 * `deckPlacement`）。
 *
 * カードの識別子を書かないので、当てはまるトレーナーズはカードプールから動かして探す。
 */

import { describe, expect, it } from "vitest";
import {
  applyMove,
  classifyDefId,
  createRng,
  legalMoves,
  loadGeneratedCards,
  type CardDefId,
  type DomainEvent,
  type GameState,
  type Move,
  type Player,
} from "../src/engine.js";
import { commitSeed } from "../src/fingerprint.js";
import {
  createMatch,
  deckPlacementFor,
  deckPlacementOf,
  submitMove,
  toMove,
  type DeckPlacementView,
  type Match,
} from "../src/match.js";
import { ensureCards, legalDecks, newMatch, playToEnd } from "./helpers.js";

interface Played {
  match: Match;
  seat: Player;
}

/** 山札の大半をそのトレーナーズにして、最初に使える番で使ったところ。使えなければ null。 */
function afterPlaying(trainer: CardDefId): Played | null {
  const [deck] = legalDecks();
  const energy = deck.cards.at(-1);
  const cards = deck.cards.filter((defId) => defId !== energy);
  while (cards.length < deck.cards.length) cards.push(trainer);
  const match = createMatch({
    matchId: `placement-${trainer}`,
    decks: [{ cards }, { cards }],
    seats: [
      { playerId: "player-a", displayName: "あ", rating: 1500 },
      { playerId: "player-b", displayName: "い", rating: 1500 },
    ],
    seatTokens: ["token-a", "token-b"],
    spectatorToken: "token-watch",
    nowMs: 0,
    startedAt: new Date(0).toISOString(),
    seedCommitment: commitSeed(`placement-${trainer}`),
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

/** 使ったところで、条件に合うトレーナーズ。 */
function findTrainer(matches: (played: Played) => boolean): CardDefId {
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
      return played !== null && matches(played);
    });
  if (found === undefined) throw new Error("条件に合うトレーナーズが見つからない");
  return found;
}

function isCardAnswer(move: Move): boolean {
  return (
    move.type === "AnswerChoice" && (move.answer.kind === "card" || move.answer.kind === "cardDef")
  );
}

function cardAnswers(match: Match): Move[] {
  return legalMoves(match.state).filter(isCardAnswer);
}

function answeredDefId(match: Match, move: Move): CardDefId {
  if (move.type !== "AnswerChoice") throw new Error("選択の答えではない");
  const answer = move.answer;
  if (answer.kind === "cardDef") return answer.defId;
  if (answer.kind !== "card") throw new Error("カードを選ぶ答えではない");
  const side = match.state.players[move.player];
  const found = [...side.hand, ...side.deck, ...side.discard].find(
    (card) => card.instanceId === answer.card,
  );
  if (found === undefined) throw new Error("選んだカードが見つからない");
  return found.defId;
}

/** 1 つ目と 2 つ目の答えで、同じ端へ順に置くトレーナーズを使ったところ。1 枚だけなら順番の問題は起きない。 */
function stacking(edge: "top" | "bottom"): Played {
  const trainer = findTrainer(({ match, seat }) => {
    if (deckPlacementFor(match, seat)?.edge !== edge) return false;
    submitMove(match, seat, match.version, cardAnswers(match)[0] as Move, 0);
    const second = deckPlacementFor(match, seat);
    return second?.edge === edge && second.nth === 2;
  });
  return afterPlaying(trainer) as Played;
}

/**
 * 効果の終わりまで先頭の候補で答えた局面と、そのあいだのイベント。選べるカードが無い選択も
 * 選択として来るので、答えが 1 つ（選ばない）しか無ければそれで答えて先へ進む。
 */
function answerToEnd(state: GameState, seat: Player): { state: GameState; events: DomainEvent[] } {
  const events: DomainEvent[] = [];
  while (state.choices.at(-1)?.owner === seat) {
    const legal = legalMoves(state);
    const answer = legal.find(isCardAnswer) ?? (legal.length === 1 ? legal[0] : undefined);
    if (answer === undefined) break;
    const applied = applyMove(state, answer);
    events.push(...applied.events);
    state = applied.state;
  }
  return { state, events };
}

/** 手札から山札へ戻したカード（戻した順）。 */
function returnedFromHand(events: DomainEvent[], seat: Player): string[] {
  return events.flatMap((event) =>
    event.kind === "card-moved" &&
    event.from.kind === "hand" &&
    event.to.kind === "deck" &&
    event.to.player === seat
      ? [event.card.instanceId]
      : [],
  );
}

describe("山札の端へ順に置く選択", () => {
  it("上へ置くなら、1 枚目はいちばん上、2 枚目はその下と出し、先に置いたカードを添える", () => {
    const { match, seat } = stacking("top");
    expect(deckPlacementFor(match, seat)).toEqual({ edge: "top", nth: 1, above: [] });
    // 選んでいるのは手番の座席だけで、相手には出さない。
    expect(deckPlacementFor(match, (1 - seat) as Player)).toBeNull();

    const first = cardAnswers(match).at(-1) as Move;
    const firstDefId = answeredDefId(match, first);
    submitMove(match, seat, match.version, first, 0);
    expect(deckPlacementFor(match, seat)).toEqual({ edge: "top", nth: 2, above: [firstDefId] });

    const second = cardAnswers(match)[0] as Move;
    const secondDefId = answeredDefId(match, second);
    submitMove(match, seat, match.version, second, 0);
    const deck = match.state.players[seat].deck;
    expect(deck.slice(0, 2).map((card) => card.defId)).toEqual([firstDefId, secondDefId]);
    expect(match.deckStack).toBeNull();
    expect(deckPlacementFor(match, seat)).toBeNull();
  });

  for (const edge of ["top", "bottom"] as const) {
    it(`${edge === "top" ? "上" : "下"}へ置くとき、出した位置はどのカードを選んでも実際に入る位置と合う`, () => {
      const { match, seat } = stacking(edge);
      let shown = 0;
      for (;;) {
        const placement = deckPlacementFor(match, seat);
        if (placement === null) break;
        shown += 1;
        expect(placement.nth).toBe(shown);
        for (const answer of cardAnswers(match)) {
          const defId = answeredDefId(match, answer);
          const deck = applyMove(match.state, answer).state.players[seat].deck;
          const expected = [...placement.above, defId];
          const actual =
            edge === "top" ? deck.slice(0, expected.length) : deck.slice(-expected.length);
          expect(actual.map((card) => card.defId)).toEqual(expected);
        }
        submitMove(match, seat, match.version, cardAnswers(match)[0] as Move, 0);
      }
      expect(shown).toBeGreaterThanOrEqual(2);
    });
  }

  it("山札から選んでも、山札へ戻さない選択では出さない", () => {
    const trainer = findTrainer(({ match, seat }) => {
      const choice = match.state.choices.at(-1);
      if (choice?.owner !== seat || choice.prompt.kind !== "selectFromHiddenZone") return false;
      const zone = choice.prompt.zone;
      const answer = cardAnswers(match)[0];
      if (zone.kind !== "deck" || zone.player !== seat || answer === undefined) return false;
      const before = match.state.players[seat].deck.length;
      return applyMove(match.state, answer).state.players[seat].deck.length < before;
    });
    const { match, seat } = afterPlaying(trainer) as Played;
    expect(deckPlacementFor(match, seat)).toBeNull();
  });

  it("手札から山札へ戻したあとで山札を切る選択では、切った結果がたまたま端に並ぶ乱数でも位置を出さない", () => {
    const trainer = findTrainer(({ match, seat }) => {
      const { events } = answerToEnd(match.state, seat);
      const returned = events.findIndex(
        (event) =>
          event.kind === "card-moved" && event.from.kind === "hand" && event.to.kind === "deck",
      );
      return (
        returned >= 0 && events.slice(returned).some((event) => event.kind === "deck-shuffled")
      );
    });
    const { match, seat } = afterPlaying(trainer) as Played;
    // 対戦の乱数で切ると、戻したカードがちょうど山札の下に並ぶ局面を作る。
    // 先読みがこの乱数を使えば位置を出してしまい、これから切る結果を座席へ漏らす。
    const lucky = Array.from({ length: 5000 }, (_, index) => ({
      ...match.state,
      rng: createRng(index.toString(16)),
    })).find((state) => {
      const { state: after, events } = answerToEnd(state, seat);
      const returned = returnedFromHand(events, seat);
      const deck = after.players[seat].deck.map((card) => card.instanceId);
      return returned.length > 0 && deck.slice(-returned.length).join() === returned.join();
    });
    expect(lucky).toBeDefined();
    expect(lucky?.choices.at(-1)?.owner).toBe(seat);
    expect(deckPlacementOf(lucky as GameState, null)).toBeNull();
  });

  it("効果の出どころを持たない選択（対戦準備など）では出さない", () => {
    const shown: DeckPlacementView[] = [];
    playToEnd(newMatch("deck-placement-none"), 7, {
      maxMoves: 400,
      inspect: (match, seat) => {
        const placement = deckPlacementFor(match, seat);
        if (placement !== null) shown.push(placement);
      },
    });
    expect(shown).toEqual([]);
  });
});
