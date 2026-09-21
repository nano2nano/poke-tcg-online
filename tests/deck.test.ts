/** デッキの検証（`docs/spec/battle-server.md` 5.1 節）。 */

import { describe, expect, it } from "vitest";
import { validateDeck } from "../src/deck.js";
import { basicEnergyDefId, ensureCards, legalDecks } from "./helpers.js";

function kinds(deck: { cards: string[] }): string[] {
  return validateDeck(deck).map((violation) => violation.kind);
}

describe("デッキの検証", () => {
  it("60 枚の正しいデッキを通す", () => {
    ensureCards();
    expect(validateDeck(legalDecks()[0])).toEqual([]);
  });

  it("枚数が 60 でないデッキを弾く", () => {
    ensureCards();
    const deck = { cards: legalDecks()[0].cards.slice(0, 59) };
    expect(kinds(deck)).toContain("size");
  });

  it("同じ名前のカードが 5 枚以上あるデッキを弾く", () => {
    ensureCards();
    const base = legalDecks()[0].cards;
    const first = base[0] as string;
    // 先頭のカードを 5 枚にして、そのぶん末尾を削る。
    const deck = { cards: [first, first, first, first, first, ...base.slice(5)] };
    expect(kinds(deck)).toContain("same-name");
  });

  it("基本エネルギーは同名の制限の外に置く", () => {
    ensureCards();
    const energy = basicEnergyDefId();
    const basic = (legalDecks()[0].cards as string[]).find((defId) => defId !== energy) as string;
    const deck = { cards: [basic, ...Array.from({ length: 59 }, () => energy)] };
    expect(kinds(deck)).not.toContain("same-name");
  });

  it("たねポケモンが 1 枚もないデッキを弾く", () => {
    ensureCards();
    const deck = { cards: Array.from({ length: 60 }, () => basicEnergyDefId()) };
    expect(kinds(deck)).toContain("no-basic");
  });

  it("正規データに無いカードを弾き、そのときは他の検査を出さない", () => {
    ensureCards();
    const deck = { cards: ["この-defid-は-存在しない", ...legalDecks()[0].cards.slice(1)] };
    expect(kinds(deck)).toEqual(["unknown-card"]);
  });
});
