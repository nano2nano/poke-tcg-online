import { describe, expect, it } from "vitest";
import type { PlayerEvent, PlayerView } from "../../src/engine.js";
import { toMove, viewFor } from "../../src/match.js";
import { ensureCards, finishSetup, newMatch } from "../../tests/helpers.js";
import { boardMoves, shuffledDecks, type BoardSide, type BoardSides } from "./board-moves.js";

/** 準備を終えた盤面を、最初に指す座席から見たもの。 */
function firstTurn(): PlayerView {
  ensureCards();
  const match = newMatch("board-moves");
  finishSetup(match);
  return viewFor(match, toMove(match)!);
}

function sides(view: PlayerView): BoardSides {
  return { near: view.self, far: view.opponent, stadium: view.stadium };
}

function handOf(view: PlayerView) {
  if (!("hand" in view.self)) throw new Error("自分の手札が見えない");
  return view.self.hand;
}

function activeOf(side: PlayerView["self"] | PlayerView["opponent"]) {
  const active = side.active;
  if (active === null || "concealed" in active) throw new Error("バトル場にポケモンがいない");
  return active;
}

const moves = (before: PlayerView, after: PlayerView, shuffled: readonly BoardSide[] = []) =>
  boardMoves(sides(before), sides(after), shuffled);

/** 手札を全部、別の ID のカードに引き直した局面。山札とサイドの枚数は変えない。 */
function redrawn(before: PlayerView) {
  const after = structuredClone(before);
  const hand = handOf(after);
  const returned = hand.map((card) => card.instanceId);
  hand.splice(
    0,
    hand.length,
    ...hand.map((card, index) => ({ ...card, instanceId: `引いた ${index}` })),
  );
  return { after, returned };
}

describe("boardMoves", () => {
  it("手札を山札へもどして切り、同じ枚数を引くと、山札の枚数が変わらなくても山札へ入れて山札から出す", () => {
    const before = firstTurn();
    const { after, returned } = redrawn(before);
    const { arrivals, departures } = moves(before, after, ["near"]);
    expect(returned.map((id) => departures.get(id))).toEqual(
      returned.map((_, order) => ({ place: { side: "near", zone: "deck" }, order })),
    );
    expect(arrivals.get("引いた 0")).toEqual({ place: { side: "near", zone: "deck" }, order: 0 });
    expect(arrivals.get("引いた 1")?.order).toBe(1);
  });

  it("山札もサイドも枚数が変わらず、山札も切っていなければ、手札の行き先と来た場所は分からないので動かさない", () => {
    const before = firstTurn();
    const { after } = redrawn(before);
    const { arrivals, departures } = moves(before, after, ["far"]);
    expect(departures.size).toBe(0);
    expect(arrivals.size).toBe(0);
  });

  it("手札のカードをサイドへ置くと、サイドへ入れる", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    const [card] = handOf(after).splice(0, 1);
    after.self.prizeCount += 1;
    expect(moves(before, after).departures.get(card!.instanceId)?.place).toEqual({
      side: "near",
      zone: "prizes",
    });
  });

  it("トラッシュの上のカードの下へ入ったカードは、トラッシュへ動かす", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    const [under, top] = handOf(after).splice(0, 2);
    after.self.discard.push(under!, top!);
    const { departures } = moves(before, after);
    // 上に載ったカードは、トラッシュに描くので要素ごと動く。
    expect(departures.has(top!.instanceId)).toBe(false);
    expect(departures.get(under!.instanceId)?.place).toEqual({ side: "near", zone: "discard" });
  });

  it("トラッシュの上のカードは、上に別のカードが載っても動かさない", () => {
    const view = firstTurn();
    const before = structuredClone(view);
    const [old] = handOf(before).splice(0, 1);
    before.self.discard.push(old!);
    const after = structuredClone(before);
    const [card] = handOf(after).splice(0, 1);
    after.self.discard.push(card!);
    expect(moves(before, after).departures.size).toBe(0);
  });

  it("トラッシュの下にあったカードを手札へ加えると、トラッシュから出す", () => {
    const view = firstTurn();
    const before = structuredClone(view);
    const [card, top] = handOf(before).splice(0, 2);
    before.self.discard.push(card!, top!);
    const after = structuredClone(before);
    after.self.discard.splice(0, 1);
    handOf(after).push(card!);
    expect(moves(before, after).arrivals.get(card!.instanceId)?.place).toEqual({
      side: "near",
      zone: "discard",
    });
  });

  it("相手の場のポケモンが相手の手札へもどると、相手の伏せた手札へ入れる", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    const active = activeOf(before.opponent);
    after.opponent.active = null;
    after.opponent.handCount += active.stack.length + active.attached.length;
    expect(moves(before, after).departures.get(active.stack.at(-1)!.instanceId)?.place).toEqual({
      side: "far",
      zone: "hand",
    });
  });

  it("山札からベンチへ出したポケモンは、山札から出す", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    const benched = structuredClone(activeOf(after.self));
    benched.inPlayId = "山札から出たポケモン";
    benched.stack = benched.stack.map((card) => ({ ...card, instanceId: "山札から出たカード" }));
    benched.attached = [];
    after.self.bench.push(benched);
    after.self.deckCount -= 1;
    expect(moves(before, after).arrivals.get("山札から出たカード")?.place).toEqual({
      side: "near",
      zone: "deck",
    });
  });

  it("相手の伏せた手札と山札が一緒に減ると、場に出たカードがどちらから来たか分からないので動かさない", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    const benched = structuredClone(activeOf(after.opponent));
    benched.inPlayId = "相手が出したポケモン";
    benched.stack = benched.stack.map((card) => ({ ...card, instanceId: "相手が出したカード" }));
    benched.attached = [];
    after.opponent.bench.push(benched);
    after.opponent.handCount -= 1;
    after.opponent.deckCount -= 1;
    expect(moves(before, after).arrivals.has("相手が出したカード")).toBe(false);
  });

  it("相手が手札から出したカードは、相手の伏せた手札から出す", () => {
    const before = firstTurn();
    const after = structuredClone(before);
    activeOf(after.opponent).attached.push({ instanceId: "相手がつけたカード", defId: "x" });
    after.opponent.handCount -= 1;
    expect(moves(before, after).arrivals.get("相手がつけたカード")?.place).toEqual({
      side: "far",
      zone: "hand",
    });
  });
});

describe("shuffledDecks", () => {
  it("同じ座席が続けて切っても 1 度にする", () => {
    const shuffle = (player: 0 | 1) => ({ kind: "deck-shuffled", player }) as PlayerEvent;
    expect(shuffledDecks([shuffle(1), shuffle(1), shuffle(0)])).toEqual([1, 0]);
  });
});
