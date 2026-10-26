import { describe, expect, it } from "vitest";
import { appendToLog } from "./event-log.js";

describe("appendToLog", () => {
  it("見出しの下に、次の見出しまでの行をまとめる。続きが次の局面で届いても同じまとまりに足す", () => {
    const first = appendToLog([], [{ text: "使った", opens: true }, { text: "引いた" }]);
    const log = appendToLog(first, [{ text: "トラッシュした" }, { text: "番", opens: true }]);
    expect(
      log.map(({ id, text, details }) => [id, text, details.map((line) => line.text)]),
    ).toEqual([
      [4, "番", []],
      [1, "使った", ["引いた", "トラッシュした"]],
    ]);
  });

  it("山札を見てから取り出したら、同じ山札を見た行は外して取り出した行だけを残す", () => {
    const looked = appendToLog(
      [],
      [
        { text: "使った", opens: true },
        { text: "あの山札を見た", deckSeen: 0 },
        { text: "いの山札を見た", deckSeen: 1 },
        { text: "あの山札のピカチュウを見せた", deckSeen: 0 },
      ],
    );
    const [entry] = appendToLog(looked, [{ text: "加えた", deckTaken: 0 }]);
    expect(entry?.details.map((line) => line.text)).toEqual(["いの山札を見た", "加えた"]);
  });

  it("盤面のイベントではない知らせは、開いている見出しがあっても 1 行だけのまとまりにする", () => {
    const log = appendToLog(
      appendToLog([], [{ text: "使った", opens: true }]),
      [{ text: "負け" }],
      true,
    );
    expect(log.map(({ text, details }) => [text, details.length])).toEqual([
      ["負け", 0],
      ["使った", 0],
    ]);
  });

  it("見出しで始まっていないまとまりには足さず、1 行ずつにする", () => {
    const log = appendToLog(
      [{ id: 1, text: "手が通りませんでした", details: [] }],
      [{ text: "引いた" }],
    );
    expect(log.map(({ text, details }) => [text, details.length])).toEqual([
      ["引いた", 0],
      ["手が通りませんでした", 0],
    ]);
  });
});
