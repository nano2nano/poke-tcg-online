import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareFor, storedDeck, type Seated } from "./join.js";
import { rememberSeat } from "./seat.js";

let items: Map<string, string>;

beforeEach(() => {
  items = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
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

describe("shareFor", () => {
  const seated: Seated = {
    matchId: "対戦",
    seat: 1,
    seatToken: "座席",
    seedCommit: "サーバのコミット",
    seedShareCommits: ["相手のコミット", "自分のコミット"],
  };

  it("覚えている座席が同じなら、そのシェアを使う", () => {
    rememberSeat({ ...seated, seedShare: "覚えていたシェア" });
    expect(shareFor(seated, null)).toBe("覚えていたシェア");
  });

  it("前に頼んだときのシェアは、この席のコミットに合うときだけ使う", () => {
    expect(shareFor(seated, { share: "前のシェア", commit: "自分のコミット" })).toBe("前のシェア");
    // 相手の席のコミットに合っても、自分のシェアではない。
    expect(shareFor(seated, { share: "前のシェア", commit: "相手のコミット" })).toBeUndefined();
  });

  it("別の座席を覚えていても、そのシェアは使わない", () => {
    rememberSeat({ ...seated, seatToken: "別の座席", seedShare: "別のシェア" });
    expect(shareFor(seated, null)).toBeUndefined();
  });
});
