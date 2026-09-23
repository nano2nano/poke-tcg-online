/**
 * デッキを組む画面が使うカードの表（`src/card-index.ts`）。
 *
 * 同じ名前で `defId` が違うカードは多い（`docs/spec/battle-server.md` 5.3 節）。画面は
 * この表の値だけを並べて人に選ばせるので、値がそろって同じ 2 枚があると、人は見分けられない
 * まま片方を選ぶことになる。
 */

import { describe, expect, it } from "vitest";
import { cardIndex } from "../src/card-index.js";
import { ensureCards } from "./helpers.js";

describe("カードの表", () => {
  it("同じ名前のカードは、表に載る値で見分けられる", () => {
    ensureCards();
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const [defId, brief] of Object.entries(cardIndex())) {
      const key = JSON.stringify(brief);
      const other = seen.get(key);
      if (other !== undefined) clashes.push(`${other} と ${defId}`);
      seen.set(key, defId);
    }
    expect(clashes).toEqual([]);
  });
});
