/**
 * デッキの提出と検証（`docs/spec/battle-server.md` 5 節）。
 *
 * エンジンのコア SPEC §0 がスコープ外へ置いたデッキ構築バリデーションを、この層が引き取る。
 * ルールの判定はエンジンが持つので、ここが見るのは「デッキとして成立しているか」だけである。
 *
 * レギュレーションマークによるスタンダードの判定は行わない（5.1 節）。
 * 正規データはマークの欄を持たず、収録そのものが範囲を表す。
 */

import type { CardDefId, DeckList } from "./engine.js";
import {
  getCardDef,
  hasSetupActiveOverrideAbility,
  isAceSpec,
  isBasicPokemon,
  listUnimplementedDefIds,
} from "./engine.js";

export const DECK_SIZE = 60;

/** 同じ名前のカードの上限。基本エネルギーはこの制限の外にある。 */
export const SAME_NAME_LIMIT = 4;

/** ACE SPEC のカードはデッキに 1 枚しか入れられない。 */
export const ACE_SPEC_LIMIT = 1;

export type DeckViolation =
  | { kind: "size"; actual: number }
  | { kind: "unknown-card"; defIds: CardDefId[] }
  | { kind: "same-name"; name: string; count: number }
  | { kind: "ace-spec"; count: number }
  | { kind: "no-basic" }
  | { kind: "unimplemented"; defIds: CardDefId[] };

/**
 * 検査の順は 5.1 節のとおりで、破れをすべて集めて返す。最初の 1 件で打ち切らないのは、
 * 組んだ人が 1 度の提出で全部直せるようにするためである。
 * ただし `unknown-card`（正規データに無い `defId`）があるときは、それ以降の検査が
 * カードの定義を読めないので、その 1 件だけを返す。
 */
export function validateDeck(deck: DeckList): DeckViolation[] {
  const unknown = deck.cards.filter((defId) => !cardExists(defId));
  if (unknown.length > 0) return [{ kind: "unknown-card", defIds: [...new Set(unknown)] }];

  const violations: DeckViolation[] = [];
  if (deck.cards.length !== DECK_SIZE) {
    violations.push({ kind: "size", actual: deck.cards.length });
  }

  const byName = new Map<string, number>();
  let aceSpecs = 0;
  for (const defId of deck.cards) {
    if (isAceSpec(defId)) aceSpecs += 1;
    if (isBasicEnergy(defId)) continue;
    const name = getCardDef(defId).name;
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  // 名前の順に出す。`Map` の反復順に依存しない（コア SPEC D-4）。
  for (const name of [...byName.keys()].sort()) {
    const count = byName.get(name) as number;
    if (count > SAME_NAME_LIMIT) violations.push({ kind: "same-name", name, count });
  }
  if (aceSpecs > ACE_SPEC_LIMIT) violations.push({ kind: "ace-spec", count: aceSpecs });

  // `createGame` も同じ検査を持つが、対戦が開いたあとに例外で落ちるのを避けて先に見る。
  const canStart = deck.cards.some(
    (defId) => isBasicPokemon(defId) || hasSetupActiveOverrideAbility(defId),
  );
  if (!canStart) violations.push({ kind: "no-basic" });

  const unimplemented = [...new Set(listUnimplementedDefIds(deck))];
  if (unimplemented.length > 0) violations.push({ kind: "unimplemented", defIds: unimplemented });

  return violations;
}

/**
 * 未実装の `defId` を、重複を保ったまま返す（1 枚につき 1 要素）。
 * 実際に人が組もうとしたデッキでの出現回数が、実装の優先順位を決める材料になる
 * （エンジン側 `docs/design/card-data-foundation.md` の「読み込まれたデッキから
 * 遅延的に積み上げる」運用）。
 */
export function unimplementedOccurrences(deck: DeckList): CardDefId[] {
  return listUnimplementedDefIds(deck);
}

export function describeViolation(violation: DeckViolation): string {
  switch (violation.kind) {
    case "size":
      return `デッキは ${DECK_SIZE} 枚ちょうどでなければならない（${violation.actual} 枚）`;
    case "unknown-card":
      return `カードの定義が見つからない: ${violation.defIds.join(", ")}`;
    case "same-name":
      return `同じ名前のカードは ${SAME_NAME_LIMIT} 枚まで: ${violation.name} が ${violation.count} 枚`;
    case "ace-spec":
      return `ACE SPEC のカードは ${ACE_SPEC_LIMIT} 枚まで（${violation.count} 枚）`;
    case "no-basic":
      return "たねポケモンが 1 枚もない（対戦準備でバトル場に出せるカードが要る）";
    case "unimplemented":
      return `まだ実装していないカードを含む: ${violation.defIds.join(", ")}`;
  }
}

function cardExists(defId: CardDefId): boolean {
  try {
    getCardDef(defId);
    return true;
  } catch {
    return false;
  }
}

function isBasicEnergy(defId: CardDefId): boolean {
  const def = getCardDef(defId);
  return def.kind === "energy" && def.basic;
}
