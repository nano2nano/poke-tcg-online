/**
 * 公式のデッキコードから読んだカード ID の解決（`docs/spec/battle-server.md` 5.4 節）。
 *
 * カード ID はテストに書き写さず、エンジンの `prints` から引く。
 */

import { describe, expect, it } from "vitest";
import type { CardDef } from "../src/engine.js";
import { loadGeneratedCards } from "../src/engine.js";
import { resolveOfficialDeck } from "../src/official-deck.js";
import { sampleDeck } from "../src/sample-deck.js";
import { ensureCards } from "./helpers.js";

let cardIdIndex: Map<string, CardDef[]> | null = null;

/** カード ID → それを収録に持つ定義。 */
function byCardId(): Map<string, CardDef[]> {
  if (cardIdIndex !== null) return cardIdIndex;
  ensureCards();
  const built = new Map<string, CardDef[]>();
  for (const def of loadGeneratedCards()) {
    for (const print of def.prints) {
      built.set(print.cardID, [...(built.get(print.cardID) ?? []), def]);
    }
  }
  cardIdIndex = built;
  return built;
}

/** その定義だけが持つカード ID。再録のあるカードは、どの収録の ID からも同じ定義に決まる。 */
function cardIdsOf(def: CardDef): string[] {
  return def.prints
    .map((print) => print.cardID)
    .filter((cardId) => byCardId().get(cardId)?.length === 1);
}

describe("公式のデッキコードの解決", () => {
  it("カード ID と枚数を、受け取った順の defId と枚数にする", () => {
    ensureCards();
    const counts = new Map<string, number>();
    for (const defId of sampleDeck().cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
    const defs = new Map(loadGeneratedCards().map((def) => [def.defId, def]));
    const cards = [...counts].map(([defId, count]) => ({
      cardId: cardIdsOf(defs.get(defId) as CardDef)[0] as string,
      count,
    }));

    const result = resolveOfficialDeck(cards);

    expect(result.failures).toEqual([]);
    expect(result.entries).toEqual([...counts].map(([defId, count]) => ({ defId, count })));
  });

  it("再録の古い収録の ID でも、同じ定義に決まり、枚数をまとめる", () => {
    const def = loadGeneratedCards().find((candidate) => cardIdsOf(candidate).length > 1);
    if (def === undefined) throw new Error("再録のあるカードが無い");
    const [older, newer] = cardIdsOf(def) as [string, string];

    const result = resolveOfficialDeck([
      { cardId: older, count: 1 },
      { cardId: newer, count: 2 },
    ]);

    expect(result.entries).toEqual([{ defId: def.defId, count: 3 }]);
  });

  it("エンジンに無いカード ID は、枚数をつけて返し、決まったぶんは捨てない", () => {
    const known = loadGeneratedCards().find((def) => cardIdsOf(def).length > 0) as CardDef;
    const missing = String(Math.max(...[...byCardId().keys()].map(Number)) + 1);

    const result = resolveOfficialDeck([
      { cardId: cardIdsOf(known)[0] as string, count: 2 },
      { cardId: missing, count: 3 },
    ]);

    expect(result.entries).toEqual([{ defId: known.defId, count: 2 }]);
    expect(result.failures).toEqual([{ kind: "unknown-card", cardId: missing, count: 3 }]);
  });

  /**
   * 同じカード ID を持つ定義が 2 つある（左右 2 枚で 1 つのスタジアム）。推測で片方を
   * 採ると、例外も出ないまま別のカードでデッキができる。
   */
  it("定義が 1 つに決まらないカード ID は、候補を返して入れない", () => {
    const shared = [...byCardId()].find(([, defs]) => defs.length > 1);
    if (shared === undefined) throw new Error("定義が 2 つ以上あるカード ID が無い");
    const [cardId, defs] = shared;

    const result = resolveOfficialDeck([{ cardId, count: 2 }]);

    expect(result.entries).toEqual([]);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure?.kind).toBe("ambiguous");
    if (failure?.kind !== "ambiguous") return;
    expect(failure.count).toBe(2);
    expect(failure.choices.map((choice) => choice.defId)).toEqual(
      defs.map((def) => def.defId).sort(),
    );
  });
});
