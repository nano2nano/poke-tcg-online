import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, Move } from "../../src/engine.js";
import { viewFor } from "../../src/match.js";
import { ensureCards, newMatch } from "../../tests/helpers.js";
import type { CardTable } from "./cards.js";
import { readerView } from "./describe.js";
import { describeMove } from "./describe-move.js";

const answering = (answer: ChoiceAnswer) =>
  describeMove(
    { type: "AnswerChoice", player: 0, choiceId: "c1", answer },
    { view: null, cards: {} },
  );

describe("describeMove", () => {
  it("特殊状態を選ぶ答えは、特殊状態の名前で出す", () => {
    expect(answering({ kind: "condition", condition: "asleep" })).toBe("ねむり");
  });

  it("HP を当てる答えは、答える HP で出す", () => {
    expect(answering({ kind: "hpGuess", value: 120 })).toBe("HP 120");
  });
});

describe("済んだ対戦を読み返す盤面", () => {
  it("相手が手札から出したカードも、名前で出す", () => {
    ensureCards();
    const match = newMatch("describe-move-reader");
    const views = [viewFor(match, 0), viewFor(match, 1)] as const;
    const [played] = views[1].self.hand;
    if (played === undefined) throw new Error("座席 1 の手札が空");
    const move: Move = {
      type: "PlayBasic",
      player: 1,
      cardInstanceId: played.instanceId,
      to: { kind: "bench", player: 1, index: 0 },
    };
    const cards = { [played.defId]: { name: "読み返すカード" } } as unknown as CardTable;

    expect(describeMove(move, { view: readerView(views, 0), cards })).toBe(
      "読み返すカード をベンチに出す",
    );
    // 座席の射影では、相手の手札の中身は見えない。
    expect(describeMove(move, { view: views[0], cards })).not.toContain("読み返すカード");
  });
});
