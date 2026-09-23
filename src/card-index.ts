/**
 * `defId` から表示に要る値を引く表。
 *
 * 盤面の射影（`playerView`）はカードを `{instanceId, defId}` としか持たない。
 * 名前はカードの定義の側にあり、それは対戦ごとに変わらないので、
 * 局面に混ぜず一度だけ配る。クライアントは取得して持っておく。
 *
 * デッキを組む画面もこの表から検索する。同じ名前の別のカードが多い（5.3 節）ので、
 * 人が見分けに使う値も載せる。
 */

import type { CardDef } from "./engine.js";
import { isAceSpec, loadGeneratedCards, stadiumHalfOf } from "./engine.js";

export interface CardBrief {
  name: string;
  kind: string;
  hp?: number;
  /** ポケモンのタイプ。同じ名前でタイプの違うカードがある。 */
  type?: string;
  stage?: "basic" | "stage1" | "stage2";
  attacks?: string[];
  abilities?: string[];
  trainerKind?: "item" | "supporter" | "tool" | "stadium";
  /** 左右 2 枚で 1 つになるスタジアム。同じ名前の 2 枚は、ここしか違わない。 */
  stadiumHalf?: "right" | "left";
  /** 同じ名前の 4 枚制限の外にあるので、組む画面が上限を変える。 */
  basicEnergy?: true;
  /** デッキに 1 枚まで。組む画面が、2 枚目を足せないようにする。 */
  aceSpec?: true;
  /** いちばん新しい収録。再録の多いカードは、古い収録では見覚えが無い。 */
  set?: string;
  number?: string;
}

let index: Record<string, CardBrief> | null = null;

export function cardIndex(): Record<string, CardBrief> {
  if (index !== null) return index;
  const built: Record<string, CardBrief> = {};
  for (const def of loadGeneratedCards()) built[def.defId] = briefOf(def);
  index = built;
  return built;
}

export function briefOf(def: CardDef): CardBrief {
  const print = def.prints[def.prints.length - 1];
  const half = stadiumHalfOf(def.defId);
  return {
    name: def.name,
    kind: def.kind,
    ...(def.kind === "pokemon"
      ? {
          hp: def.hp,
          type: def.type,
          stage: def.evolutionStage,
          attacks: def.attacks.map((attack) => attack.name),
          ...(def.abilities === undefined
            ? {}
            : { abilities: def.abilities.map((ability) => ability.name) }),
        }
      : {}),
    ...(def.kind === "trainer" ? { trainerKind: def.trainerKind } : {}),
    ...(half === null ? {} : { stadiumHalf: half }),
    ...(def.kind === "energy" && def.basic ? { basicEnergy: true } : {}),
    ...(isAceSpec(def.defId) ? { aceSpec: true } : {}),
    ...(print === undefined || print.set === "" ? {} : { set: print.set }),
    ...(print?.number == null ? {} : { number: print.number }),
  };
}
