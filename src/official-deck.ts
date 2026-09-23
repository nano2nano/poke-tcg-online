/**
 * 公式サイトのデッキコードから取り出した「カード ID と枚数」を `defId` の列へ直す
 * （`docs/spec/battle-server.md` 5.4 節）。
 *
 * 公式サイトのページはブラウザが直接取る。サーバが受け取るのはカード ID と枚数だけで、
 * 公式サイトへは取りに行かない。
 *
 * カード ID は版ごとに振られていて、エンジンの `prints` が持つ値と同じなので、名前と違って
 * ほぼ一意に `defId` が決まる。決まらない ID は、名前のときと同じく推測せず候補を返す。
 */

import type { CardDef, CardDefId } from "./engine.js";
import { loadGeneratedCards } from "./engine.js";
import { choiceOf, type CardChoice } from "./decklist.js";

export interface OfficialCard {
  cardId: string;
  count: number;
}

export type OfficialFailure =
  | { kind: "unknown-card"; cardId: string; count: number }
  | { kind: "ambiguous"; cardId: string; count: number; choices: CardChoice[] };

export interface OfficialDeckResult {
  /** 決まったぶん。受け取った順に並べ、同じ `defId` は 1 つにまとめる。 */
  entries: { defId: CardDefId; count: number }[];
  failures: OfficialFailure[];
}

/**
 * 決まらないカードがあっても、決まったぶんは返す。デッキコードは組み終えたデッキなので、
 * 1 枚のために全部を捨てると、残りを検索から組み直すことになる。
 */
export function resolveOfficialDeck(cards: OfficialCard[]): OfficialDeckResult {
  const entries: { defId: CardDefId; count: number }[] = [];
  const failures: OfficialFailure[] = [];
  for (const { cardId, count } of cards) {
    const defs = byCardId().get(cardId) ?? [];
    const only = defs[0];
    if (only === undefined) {
      failures.push({ kind: "unknown-card", cardId, count });
    } else if (defs.length > 1) {
      failures.push({
        kind: "ambiguous",
        cardId,
        count,
        choices: defs.map(choiceOf),
      });
    } else {
      const same = entries.find((entry) => entry.defId === only.defId);
      if (same === undefined) entries.push({ defId: only.defId, count });
      else same.count += count;
    }
  }
  return { entries, failures };
}

let cardIdIndex: Map<string, CardDef[]> | null = null;

/** カード ID → 定義。候補の並びは `defId` の昇順で、入力が同じなら結果も同じになる（D-4）。 */
function byCardId(): Map<string, CardDef[]> {
  if (cardIdIndex !== null) return cardIdIndex;
  const built = new Map<string, CardDef[]>();
  for (const def of loadGeneratedCards()) {
    for (const cardId of new Set(def.prints.map((print) => print.cardID))) {
      const defs = built.get(cardId);
      if (defs === undefined) built.set(cardId, [def]);
      else defs.push(def);
    }
  }
  for (const defs of built.values()) defs.sort((a, b) => (a.defId < b.defId ? -1 : 1));
  cardIdIndex = built;
  return built;
}
