/**
 * 動作確認用のデッキを、登録済みのカードから実行時に組む。
 *
 * **カードの識別子をこのリポジトリへ書き込まないため**に、固定のデッキ表を持たない。
 * カードの定義はすべてエンジンの側にあり、ここが持つのは「何を満たせばデッキか」だけである。
 *
 * 参照クライアント（`public/`）と試験がこれを使う。対戦の本番でこれが使われることはない。
 * 人が組んだデッキは `POST /api/join` が運ぶ。
 */

import type { CardDef, CardDefId, DeckList } from "./engine.js";
import { classifyDefId, entersPlayOnlyViaEffect, loadGeneratedCards } from "./engine.js";
import { DECK_SIZE, SAME_NAME_LIMIT, validateDeck } from "./deck.js";

/** たねポケモンの種類数。残りは基本エネルギーで埋める。 */
const BASIC_KINDS = 3;

let cached: DeckList | null = null;

/**
 * たねポケモンを数種類 4 枚ずつと、基本エネルギーで 60 枚にする。
 *
 * 強いデッキを作らない。プロトコルと画面が動くことを見るためのもので、
 * 満たすのは検査（`validateDeck`）を通ることと、対戦が始まることだけである。
 * 選び方は `defId` の昇順で、同じカードプールなら常に同じデッキになる。
 */
export function sampleDeck(): DeckList {
  if (cached !== null) return cached;

  const defs = [...loadGeneratedCards()].sort((a, b) => (a.defId < b.defId ? -1 : 1));
  // 同名の制限は名前で効くので、版違いを 2 枚拾うと 8 枚になって検査に落ちる。名前で重複を除く。
  const seen = new Set<string>();
  const basics = defs
    .filter((def) => {
      if (!isPlayableBasic(def) || seen.has(def.name)) return false;
      seen.add(def.name);
      return true;
    })
    .slice(0, BASIC_KINDS);
  const energy = defs.find(isBasicEnergy);

  if (basics.length < BASIC_KINDS || energy === undefined) {
    throw new Error("見本のデッキを組めるだけのカードが登録されていない");
  }

  const cards: CardDefId[] = [];
  for (const basic of basics) {
    for (let i = 0; i < SAME_NAME_LIMIT; i++) cards.push(basic.defId);
  }
  while (cards.length < DECK_SIZE) cards.push(energy.defId);

  const deck: DeckList = { cards };
  const violations = validateDeck(deck);
  if (violations.length > 0) {
    throw new Error(`見本のデッキが検査を通らない: ${violations.map((v) => v.kind).join(", ")}`);
  }
  cached = deck;
  return deck;
}

/** 手札から普通に出せるたねポケモン。効果でしか場に出ないカードは避ける。 */
function isPlayableBasic(def: CardDef): boolean {
  return (
    def.kind === "pokemon" &&
    def.evolutionStage === "basic" &&
    !entersPlayOnlyViaEffect(def.defId) &&
    classifyDefId(def.defId) === "implemented"
  );
}

function isBasicEnergy(def: CardDef): boolean {
  return def.kind === "energy" && def.basic && classifyDefId(def.defId) === "implemented";
}
