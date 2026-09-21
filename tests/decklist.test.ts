/**
 * 人が書いたデッキの解決（`docs/spec/battle-server.md` 5.3 節）。
 *
 * 名前から `defId` は一意に決まらない。**推測で埋めると、例外も出ないまま別のカードの
 * デッキができる。** 曖昧なら拒否することを、実データの衝突で確かめる。
 */

import { describe, expect, it } from "vitest";
import type { CardDef } from "../src/engine.js";
import { loadGeneratedCards } from "../src/engine.js";
import { resolveDecklist, type DecklistFailure } from "../src/decklist.js";
import { DECK_SIZE } from "../src/deck.js";
import { ensureCards } from "./helpers.js";

/** 名前 → 定義。テストがカードの名前を書き写さないためのヘルパー。 */
function byName(): Map<string, CardDef[]> {
  ensureCards();
  const built = new Map<string, CardDef[]>();
  for (const def of loadGeneratedCards()) {
    built.set(def.name, [...(built.get(def.name) ?? []), def]);
  }
  for (const defs of built.values()) defs.sort((a, b) => (a.defId < b.defId ? -1 : 1));
  return built;
}

/** `defId` が 1 つだけの名前。昇順の先頭を採るので、カードプールが同じなら常に同じ。 */
function uniqueName(matches: (def: CardDef) => boolean = () => true): string {
  const found = [...byName().entries()]
    .filter(([, defs]) => defs.length === 1 && matches(defs[0] as CardDef))
    .sort(([a], [b]) => (a < b ? -1 : 1))[0];
  if (found === undefined) throw new Error("一意な名前が無い");
  return found[0];
}

/** `defId` が 2 つ以上ある名前と、その候補。 */
function ambiguousName(): [string, CardDef[]] {
  const found = [...byName().entries()]
    .filter(([, defs]) => defs.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : 1))[0];
  if (found === undefined) throw new Error("重複する名前が無い");
  return found;
}

function kinds(failures: DecklistFailure[]): string[] {
  return failures.map((failure) => failure.kind);
}

describe("デッキの文字列の解決", () => {
  it("名前と枚数の行を defId の列にする。並びは書いた順である", () => {
    const a = uniqueName();
    const b = uniqueName((def) => def.name !== a);
    const result = resolveDecklist(`${a} 2\n${b} 3`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // インスタンス ID はデッキ配列の添字なので、順序も情報源の一部である（5.3 節）。
    expect(result.deck.cards.length).toBe(5);
    expect(result.deck.cards.slice(0, 2).every((id) => id === result.entries[0]?.defId)).toBe(true);
    expect(result.deck.cards.slice(2).every((id) => id === result.entries[1]?.defId)).toBe(true);
  });

  // ここが本題。複数の defId を持つ名前は珍しくないので、推測は必ず事故になる。
  it("同じ名前が複数あるときは、候補を返して拒否する", () => {
    const [name, defs] = ambiguousName();
    const result = resolveDecklist(`${name} 4`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toEqual(["ambiguous"]);
    const failure = result.failures[0];
    if (failure?.kind !== "ambiguous") throw new Error("candidates が無い");
    expect(failure.choices.map((choice) => choice.defId)).toEqual(defs.map((def) => def.defId));
  });

  it("defId を書き添えれば、同じ名前でも 1 つに決まる", () => {
    const [name, defs] = ambiguousName();
    const wanted = defs[1] as CardDef;
    const result = resolveDecklist(`${name} 4 ${wanted.defId}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.deck.cards)).toEqual(new Set([wanted.defId]));
  });

  it("名前と defId が食い違う行を拒否する", () => {
    const [name, defs] = ambiguousName();
    const other = uniqueName((def) => def.name !== name);
    const result = resolveDecklist(`${other} 1 ${(defs[0] as CardDef).defId}`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toEqual(["name-mismatch"]);
  });

  it("枚数が先でも読み、全角の数字と空白も読む", () => {
    const name = uniqueName();
    const result = resolveDecklist(`４　${name}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.cards.length).toBe(4);
  });

  it("空行と # の行を読み飛ばす", () => {
    const name = uniqueName();
    const result = resolveDecklist(`# おぼえがき\n\n${name} 1\n`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.cards.length).toBe(1);
  });

  it("読めない行と、知らない名前を、行番号つきで返す", () => {
    const result = resolveDecklist("ぜんぜんちがう\nそんなカードはない 4");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toEqual(["unparsable", "unknown-name"]);
    expect(result.failures[0]).toMatchObject({ line: 1 });
    expect(result.failures[1]).toMatchObject({ line: 2 });
  });

  // 短い文字列から巨大な配列を作れてしまうと、それだけで攻撃になる。
  it("枚数が範囲の外の行を拒否する", () => {
    const name = uniqueName();
    const result = resolveDecklist(`${name} 0\n${name} ${DECK_SIZE + 1}`);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toEqual(["bad-count", "bad-count"]);
  });

  it("行が多すぎる入力を、読む前に拒否する", () => {
    const result = resolveDecklist("\n".repeat(500));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(kinds(result.failures)).toEqual(["too-many-lines"]);
  });

  it("違反を 1 件で打ち切らず、全部返す", () => {
    const result = resolveDecklist("ないカードA 1\nないカードB 2\nないカードC 3");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.length).toBe(3);
  });
});
