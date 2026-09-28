import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardTable } from "./cards.js";
import {
  canAdd,
  deckCodeOf,
  readOfficialPage,
  saveDeck,
  searchCards,
  searchRows,
  storedDeck,
  subscribeDeck,
  withCount,
} from "./deck.js";

let items: Map<string, string>;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("removeEventListener", () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storedDeck", () => {
  it("壊れた行は捨て、読める行は残す", () => {
    items.set(
      "poke-deck",
      JSON.stringify([
        { defId: "a", count: 2 },
        { defId: "b", count: 0 },
        { defId: "c", count: 1.5 },
        { count: 3 },
        null,
        { defId: "d", count: 999 },
      ]),
    );
    expect(storedDeck()).toEqual([
      { defId: "a", count: 2 },
      { defId: "d", count: 60 },
    ]);
  });

  it("JSON として読めなければ、組んでいないものとする", () => {
    items.set("poke-deck", "{");
    expect(storedDeck()).toEqual([]);
  });
});

describe("saveDeck", () => {
  it("残せなくても、組んだデッキはこのページのあいだ使える", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("容量が無い");
      },
      removeItem: () => {},
    });
    const changed = vi.fn<() => void>();
    const stop = subscribeDeck(changed);
    saveDeck([{ defId: "a", count: 1 }]);
    stop();
    expect(storedDeck()).toEqual([{ defId: "a", count: 1 }]);
    expect(changed).toHaveBeenCalledTimes(1);
    // 残せるようになったら、localStorage のものが今のデッキに戻る。
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    });
    saveDeck([]);
    expect(storedDeck()).toEqual([]);
    expect(items.has("poke-deck")).toBe(false);
  });
});

describe("枚数の上限", () => {
  const table: CardTable = {
    a1: { name: "A", kind: "pokemon" },
    a2: { name: "A", kind: "pokemon" },
    e: { name: "E", kind: "energy", basicEnergy: true },
    x: { name: "X", kind: "trainer", aceSpec: true },
    y: { name: "Y", kind: "trainer", aceSpec: true },
  };

  it("同じ名前は版が違っても合わせて 4 枚まで。基本エネルギーは数えない", () => {
    const deck = [
      { defId: "a1", count: 3 },
      { defId: "a2", count: 1 },
      { defId: "e", count: 10 },
    ];
    expect(canAdd(deck, table, "a2")).toBe(false);
    expect(canAdd(deck, table, "e")).toBe(true);
  });

  it("ACE SPEC はどれか 1 枚まで", () => {
    expect(canAdd([{ defId: "x", count: 1 }], table, "y")).toBe(false);
  });

  it("60 枚に届いたら足せない。表に無いカードも足せない", () => {
    expect(canAdd([{ defId: "e", count: 60 }], table, "e")).toBe(false);
    expect(canAdd([], table, "無い")).toBe(false);
  });

  it("減らしきった行は消え、無かった行は末尾に足す", () => {
    expect(withCount([{ defId: "a1", count: 1 }], "a1", -1)).toEqual([]);
    expect(withCount([{ defId: "a1", count: 1 }], "e", 1)).toEqual([
      { defId: "a1", count: 1 },
      { defId: "e", count: 1 },
    ]);
  });
});

describe("searchCards", () => {
  const table: CardTable = {
    b: { name: "ピカチュウ", kind: "pokemon", attacks: ["でんきショック"], set: "SV1" },
    a: { name: "ライチュウ", kind: "pokemon", attacks: ["ピカピカ"] },
  };

  it("ひらがなで打ってもカタカナの名前に当たり、名前の前方一致を先に並べる", () => {
    const rows = searchRows(table);
    expect(searchCards(rows, "ぴか").map((row) => row.defId)).toEqual(["b", "a"]);
  });

  it("空白で区切った語をすべて含むものだけ。ワザと収録でも当たる", () => {
    const rows = searchRows(table);
    expect(searchCards(rows, "ピカ ｓｖ１").map((row) => row.defId)).toEqual(["b"]);
    expect(searchCards(rows, "  ")).toEqual([]);
  });
});

describe("公式のデッキコード", () => {
  it("デッキのページの URL からもコードを取り出し、コードでない文字は断る", () => {
    expect(deckCodeOf("https://www.pokemon-card.com/deck/confirm.html/deckID/abc123-DEF456/")).toBe(
      "abc123-DEF456",
    );
    expect(deckCodeOf(" abc123 ")).toBe("abc123");
    expect(deckCodeOf("../x")).toBeNull();
  });

  it("欄から枚数を、スクリプトから名前を読む", () => {
    const html = "<script>PCGDECK.searchItemName[42]='ある\\'カード';</script>";
    expect(readOfficialPage(["42_2_1-7_1_1", ""], html)).toEqual({
      cards: [
        { cardId: "42", count: 2 },
        { cardId: "7", count: 1 },
      ],
      names: { "42": "ある'カード" },
    });
  });

  it("欄が空ならデッキは無い。欄そのものが無いか読めなければ、ページの形が変わっている", () => {
    expect(readOfficialPage(["", ""], "")).toBeNull();
    expect(() => readOfficialPage([], "")).toThrow("ページの形が変わっています");
    expect(() => readOfficialPage(["x_1"], "")).toThrow("ページの形が変わっています");
  });
});
