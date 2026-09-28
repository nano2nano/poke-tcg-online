import { describe, expect, it } from "vitest";
import type { ChoiceAnswer } from "../../src/engine.js";
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
