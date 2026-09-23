/**
 * デッキを組む画面が使うカードの表（`src/card-index.ts`）。
 *
 * 同じ名前で `defId` が違うカードは多い（`docs/spec/battle-server.md` 5.3 節）。画面は
 * この表の値だけを並べて人に選ばせる。収録のほかに違いの出ない 2 枚が、中身の違うカードだと、
 * 人は収録の記号だけを頼りに選ぶことになる。
 */

import { describe, expect, it } from "vitest";
import type { CardDef } from "../src/engine.js";
import { loadGeneratedCards } from "../src/engine.js";
import { briefOf } from "../src/card-index.js";
import { ensureCards } from "./helpers.js";

/** キーの順に依らない比較用の文字列。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("カードの表", () => {
  it("収録のほかに表の値が違わない 2 枚は、カードとしても同じ中身である", () => {
    ensureCards();
    const groups = new Map<string, CardDef[]>();
    for (const def of loadGeneratedCards()) {
      const { set: _set, number: _number, ...shown } = briefOf(def);
      const key = canonical(shown);
      groups.set(key, [...(groups.get(key) ?? []), def]);
    }

    const differing: string[] = [];
    for (const defs of groups.values()) {
      const [first, ...rest] = defs.map(({ defId, prints: _prints, ...body }) => ({
        defId,
        body: canonical(body),
      }));
      for (const other of rest) {
        if (other.body !== first?.body) differing.push(`${first?.defId} と ${other.defId}`);
      }
    }
    expect(differing).toEqual([]);
  });
});
