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
  type CardInstance,
  type GameState,
  type Move,
  type Player,
} from "../src/engine.js";
import { commitSeed } from "../src/fingerprint.js";
import {
  answerDestinationsFor,
  answerDestinationsOf,
  createMatch,
  disguised,
  ownsDestination,
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

/**
 * 山札の多くをそのトレーナーズにして、最初に使える番で使ったところ。使えなければ null。
 * 2 種類目の基本エネルギーは `second` 枚入れる。
 */
function afterPlaying(trainer: CardDefId, second = 12): Played | null {
  const [deck] = legalDecks();
  const [energyA, energyB] = twoBasicEnergies();
  const basics = deck.cards.slice(0, 12);
  const cards = [...basics];
  while (cards.length < 36) cards.push(trainer);
  while (cards.length < 60 - second) cards.push(energyA);
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
      case "later":
        expect(zoneSizes(after, seat)).toEqual(zoneSizes(match.state, seat));
        expect(destination.options.length).toBeGreaterThan(0);
        break;
      default:
        throw new Error(`この効果で出るとは思っていない行き先: ${destination.to}`);
    }
  });
  return checked;
}

/** 本物の局面で適用すると、選んだカードが手札に入る答えの、合法手の中の位置。 */
function toHandAnswers({ match, seat }: Played): number[] {
  const hand = (state: GameState) => state.players[seat].hand.length;
  return legalMoves(match.state).flatMap((move, index) =>
    move.type === "AnswerChoice" &&
    move.answer.kind === "cardDef" &&
    hand(applyMove(match.state, move).state) === hand(match.state) + 1
      ? [index]
      : [],
  );
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
    expect(kinds).toContainEqual(["later"]);
    expect(kinds).toContainEqual(["hand"]);
    expect(kinds).toContainEqual(["attached"]);
    expect(checked).toBeGreaterThanOrEqual(2);
    // 効果を終えたら出さない。
    expect(answerDestinationsFor(played.match, played.seat)).toBeNull();
  });

  it("あとの選択で行き先が決まるカードには、手札に加える道とポケモンにつける道の両方を出す", () => {
    const played = afterPlaying(handThenAttach()) as Played;
    const { match, seat } = played;
    const [first] = legalMoves(match.state);
    const [destination] = answerDestinationsFor(match, seat) ?? [];
    if (first?.type !== "AnswerChoice" || first.answer.kind !== "cardDef") {
      throw new Error("山札からカードを選ぶ答えではない");
    }
    expect(destination).toEqual({ to: "later", options: ["attached", "hand"] });
    const picked = first.answer.defId;

    // 手札に加える選択まで、辞退でない先頭の答えで進める。
    const isHandStep = () =>
      (answerDestinationsFor(match, seat) ?? []).some((each) => each?.to === "hand");
    while (!isHandStep()) {
      const next = legalMoves(match.state).find(
        (move) => move.type === "AnswerChoice" && move.answer.kind !== "decline",
      );
      if (next === undefined) throw new Error("手札に加える選択に届かない");
      submitMove(match, seat, match.version, next, 0);
    }
    const roles = legalMoves(match.state).filter(
      (move) => move.type === "AnswerChoice" && move.answer.kind === "cardDef",
    );
    // 選んだカードを手札に加える道がある。
    const toHand = roles.find(
      (move) =>
        move.type === "AnswerChoice" &&
        move.answer.kind === "cardDef" &&
        move.answer.defId === picked,
    );
    expect(toHand).toBeDefined();
    // もう 1 枚を手札に加えると、選んだカードはポケモンにつく。
    const other = roles.find((move) => move !== toHand) as Move;
    const landing = applyMove(match.state, other).state;
    const land = legalMoves(landing)[0] as Move;
    const attached = applyMove(landing, land).events.flatMap((event) =>
      event.kind === "energy-attached" ? [event.card.defId] : [],
    );
    expect(attached).toEqual([picked]);
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

/** ゾーンに並ぶインスタンス ID。 */
function ids(cards: readonly CardInstance[]): string[] {
  return cards.map((card) => card.instanceId);
}

describe("行き先を求めるときの差し替え", () => {
  /** トレーナーズを使ったところ。山札の 1 枚を残す印に選び、ウラのサイドを 1 枚表にしておく。 */
  function withKeptCard(): { state: GameState; seat: Player; kept: CardInstance } {
    const { match, seat } = afterPlaying(handThenAttach()) as Played;
    const side = match.state.players[seat];
    const kept = side.deck[Math.floor(side.deck.length / 2)] as CardInstance;
    const players: GameState["players"] = [match.state.players[0], match.state.players[1]];
    players[seat] = { ...side, revealedPrizes: [(side.prizes[0] as CardInstance).instanceId] };
    return { state: { ...match.state, players }, seat, kept };
  }

  it("自分の山札とウラのサイド、相手の手札・山札・サイドをまとめて混ぜ、残すカードと表のサイドは動かさない", () => {
    const { state, seat, kept } = withKeptCard();
    const own = state.players[seat];
    const rival = state.players[(1 - seat) as Player];
    const keptAt = own.deck.findIndex((card) => card.instanceId === kept.instanceId);
    let ownPrizesMoved = false;
    let rivalHandMoved = false;
    for (let tried = 0; tried < 20; tried++) {
      const after = disguised(state, seat, [kept], { ownPrizes: true, rival: true });
      const mine = after.players[seat];
      const theirs = after.players[(1 - seat) as Player];
      // 見えているゾーンは変えず、ゾーンごとの枚数も変えない。
      expect(ids(mine.hand)).toEqual(ids(own.hand));
      expect(mine.discard).toBe(own.discard);
      expect(mine.active).toBe(own.active);
      expect([mine.deck.length, mine.prizes.length]).toEqual([own.deck.length, own.prizes.length]);
      expect([theirs.hand.length, theirs.deck.length, theirs.prizes.length]).toEqual([
        rival.hand.length,
        rival.deck.length,
        rival.prizes.length,
      ]);
      // 混ぜる範囲の中身は変わらない。
      expect(ids([...mine.deck, ...mine.prizes]).sort()).toEqual(
        ids([...own.deck, ...own.prizes]).sort(),
      );
      expect(ids([...theirs.hand, ...theirs.deck, ...theirs.prizes]).sort()).toEqual(
        ids([...rival.hand, ...rival.deck, ...rival.prizes]).sort(),
      );
      expect(mine.deck[keptAt]?.instanceId).toBe(kept.instanceId);
      expect(mine.prizes[0]?.instanceId).toBe(own.prizes[0]?.instanceId);
      ownPrizesMoved ||= ids(mine.prizes).some((id) => !ids(own.prizes).includes(id));
      rivalHandMoved ||= ids(theirs.hand).some((id) => !ids(rival.hand).includes(id));
    }
    expect(ownPrizesMoved).toBe(true);
    expect(rivalHandMoved).toBe(true);
  });

  /**
   * 2 種類目のエネルギーを 1 枚だけ入れた山札で使い、その 1 枚が山札にあるところ。山札は 2 種類の
   * エネルギー 1 枚ずつを含む 4 枚まで減らす。サイドと混ぜれば、どちらかがほぼ毎回サイドへ移る。
   */
  function withOneOfSecond(): { match: Match; seat: Player; energyA: CardDefId } {
    const played = afterPlaying(handThenAttach(), 1) as Played;
    const { match, seat } = played;
    const [energyA, energyB] = twoBasicEnergies();
    const side = match.state.players[seat];
    const pickOf = (defId: CardDefId) =>
      side.deck.filter((card) => card.defId === defId).slice(0, 1);
    const others = side.deck.filter((card) => card.defId !== energyA && card.defId !== energyB);
    const deck = [...pickOf(energyB), ...pickOf(energyA), ...others.slice(0, 2)];
    if (deck.length !== 4) throw new Error("山札に 2 種類のエネルギーがそろっていない");
    const kept = new Set(ids(deck));
    const players: GameState["players"] = [match.state.players[0], match.state.players[1]];
    players[seat] = {
      ...side,
      deck,
      discard: [...side.discard, ...side.deck.filter((card) => !kept.has(card.instanceId))],
    };
    match.state = { ...match.state, players };
    return { match, seat, energyA };
  }

  it("山札全体を見せた効果では山札とサイドを混ぜず、山札にあるカードを無いことにしない", () => {
    // 座席は山札を見ているので、1 種類目を選べば、2 枚目に 2 種類目を選んで一方をつけられると知っている。
    const { match, energyA } = withOneOfSecond();
    expect(match.effectReveals?.wholeDeck).toBe(true);
    const index = legalMoves(match.state).findIndex(
      (move) =>
        move.type === "AnswerChoice" &&
        move.answer.kind === "cardDef" &&
        move.answer.defId === energyA,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect((answerDestinationsOf(match.state, match.effectReveals) ?? [])[index]).toEqual({
      to: "later",
      options: ["attached", "hand"],
    });
  });

  it("山札全体を見せた効果では、そのあとの選択でもサイドと混ぜず、どの段でも行き先を出す", () => {
    const { match, seat } = withOneOfSecond();
    const steps = walk({ match, seat });
    expect(steps.length).toBeGreaterThanOrEqual(3);
    for (const step of steps) expect(step.length).toBeGreaterThan(0);
  });

  it("山札の上から何枚かを並びのまま見せた効果では、その位置を動かさずに行き先を出す", () => {
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
      .map((trainer) => afterPlaying(trainer))
      .find(
        (played) =>
          played !== null &&
          played.match.effectReveals?.wholeDeck === false &&
          (played.match.effectReveals?.pinned.length ?? 0) > 0 &&
          toHandAnswers(played).length > 0,
      );
    if (found == null) throw new Error("上から何枚かを見せて手札に加える効果が見つからない");
    // 見せた窓を山札全体と混ぜると、選んだカードが窓の外へ出て、答えを試せなくなる。
    const destinations = answerDestinationsFor(found.match, found.seat) ?? [];
    for (const index of toHandAnswers(found)) {
      expect(destinations[index]).toEqual({ to: "hand", player: found.seat });
    }
  });

  it("既定では自分の山札だけを混ぜる", () => {
    const { state, seat, kept } = withKeptCard();
    const after = disguised(state, seat, [kept]);
    expect(ids(after.players[seat].prizes)).toEqual(ids(state.players[seat].prizes));
    expect(after.players[(1 - seat) as Player]).toBe(state.players[(1 - seat) as Player]);
  });
});

describe("あとの選択でたどる行き先の持ち主", () => {
  it("自分のゾーンと自分のポケモンだけを座席の行き先とみなす", () => {
    const { match, seat } = afterPlaying(handThenAttach()) as Played;
    const rival = (1 - seat) as Player;
    const own = match.state.players[seat].active;
    const theirs = match.state.players[rival].active;
    if (own === null || theirs === null) throw new Error("バトル場にポケモンがいない");
    expect(ownsDestination(match.state, seat, { to: "hand", player: seat })).toBe(true);
    expect(ownsDestination(match.state, seat, { to: "hand", player: rival })).toBe(false);
    expect(
      ownsDestination(match.state, seat, { to: "attached", target: own.inPlayId, cards: [] }),
    ).toBe(true);
    expect(
      ownsDestination(match.state, seat, { to: "attached", target: theirs.inPlayId, cards: [] }),
    ).toBe(false);
  });
});
