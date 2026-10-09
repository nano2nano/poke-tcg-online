import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedDeck } from "./deck.js";
import {
  claim,
  defaultBotName,
  liveSeatOf,
  resolveBotDeckChoice,
  resolveDeckChoice,
  shareFor,
  type Seated,
} from "./join.js";
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
    expect(shareFor(seated, [])).toBe("覚えていたシェア");
  });

  it("前に頼んだときのシェアは、この席のコミットに合うものだけ使う", () => {
    const mine = { share: "前のシェア", commit: "自分のコミット" };
    const other = { share: "その前のシェア", commit: "別のコミット" };
    expect(shareFor(seated, [other, mine])).toBe("前のシェア");
    // 相手の席のコミットに合っても、自分のシェアではない。
    expect(shareFor(seated, [{ share: "前のシェア", commit: "相手のコミット" }])).toBeUndefined();
  });

  it("別の座席を覚えていても、そのシェアは使わない", () => {
    rememberSeat({ ...seated, seatToken: "別の座席", seedShare: "別のシェア" });
    expect(shareFor(seated, [])).toBeUndefined();
  });
});

describe("liveSeatOf", () => {
  const seat: Seated = {
    matchId: "対戦",
    seat: 0,
    seatToken: "座席",
    seedCommit: "サーバのコミット",
    seedShareCommits: [null, null],
  };

  it("人との対戦でも AI との対戦でも、続いている対戦の席を返す", () => {
    for (const code of ["match-live", "bot-match-live"]) {
      expect(liveSeatOf({ ok: false, code, errors: [], seat })).toBe(seat);
    }
  });

  it("ほかの理由で断ったときと、席の無い断りは null", () => {
    expect(liveSeatOf({ ok: false, code: "account-not-found", errors: [], seat })).toBeNull();
    // AI の重みを読んでいる途中は、まだ席が無い。
    expect(liveSeatOf({ ok: false, code: "bot-match-live", errors: [] })).toBeNull();
    expect(liveSeatOf({ ok: true, ticket: "チケット", seat })).toBeNull();
  });
});

describe("claim", () => {
  const answer = (respond: () => Promise<Response>) =>
    vi.stubGlobal("fetch", vi.fn<() => Promise<Response>>(respond));

  it("届かなかったときと失敗の番号は、取り直せばよいので null", async () => {
    answer(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await claim("チケット")).toBeNull();
    for (const status of [503, 429, 408, 404]) {
      answer(async () => new Response("", { status }));
      expect(await claim("チケット")).toBeNull();
    }
  });

  it("成功を返したのに読めなければ、取り直しても同じなので unreadable", async () => {
    answer(async () => new Response("<!doctype html>", { status: 200 }));
    expect(await claim("チケット")).toEqual({ kind: "unreadable" });
  });

  it("読めた答えはそのまま返す", async () => {
    answer(async () => Response.json({ kind: "waiting" }));
    expect(await claim("チケット")).toEqual({ kind: "waiting" });
  });
});

describe("resolveDeckChoice", () => {
  const deck = (deckId: string, errors: string[] = []): SavedDeck => ({
    deckId,
    name: deckId,
    cards: [],
    updatedAt: "",
    errors,
  });
  const presets = [{ label: "表のデッキ", aces: [] }];

  it("選んだものが一覧にあればそれを使い、無ければ規則を通る保存したデッキ、表のデッキの順に選ぶ", () => {
    const saved = [deck("通らない", ["60 枚にしてください"]), deck("通る")];
    expect(resolveDeckChoice("sample", saved, presets)).toBe("sample");
    expect(resolveDeckChoice("saved:通らない", saved, presets)).toBe("saved:通らない");
    expect(resolveDeckChoice("saved:消した", saved, presets)).toBe("saved:通る");
    expect(resolveDeckChoice("preset:外れた", [], presets)).toBe("preset:表のデッキ");
    expect(resolveDeckChoice(null, [], [])).toBe("sample");
  });
});

describe("resolveBotDeckChoice", () => {
  const saved: SavedDeck[] = [
    { deckId: "組んだ", name: "組んだ", cards: [], updatedAt: "", errors: [] },
  ];
  const presets = [{ label: "表のデッキ", aces: [] }];

  it("選んだものが一覧にあればそれを使い、無ければ保存したデッキがあっても表のデッキを選ぶ", () => {
    expect(resolveBotDeckChoice("saved:組んだ", saved, presets)).toBe("saved:組んだ");
    expect(resolveBotDeckChoice("sample", saved, presets)).toBe("sample");
    expect(resolveBotDeckChoice(null, saved, presets)).toBe("preset:表のデッキ");
    expect(resolveBotDeckChoice("saved:消した", saved, presets)).toBe("preset:表のデッキ");
    expect(resolveBotDeckChoice(null, saved, [])).toBe("sample");
  });
});

describe("選ぶ前に出しておく AI", () => {
  it("latest が置かれていれば、一覧の先頭でなくても latest にする", () => {
    expect(defaultBotName([{ name: "2026-10-07-g546" }, { name: "latest" }])).toBe("latest");
  });

  it("latest が無ければ一覧の先頭にし、一覧が空なら空にする", () => {
    expect(defaultBotName([{ name: "b" }, { name: "a" }])).toBe("b");
    expect(defaultBotName([])).toBe("");
  });
});
