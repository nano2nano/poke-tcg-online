/**
 * `defId` から表示に要る値を引く表。
 *
 * 盤面の射影（`playerView`）はカードを `{instanceId, defId}` としか持たない。
 * 名前はカードの定義の側にあり、それは対戦ごとに変わらないので、
 * 局面に混ぜず一度だけ配る。クライアントは取得して持っておく。
 *
 * デッキを組む画面もこの表から検索する。同じ名前の別のカードが多い（5.3 節）ので、
 * 人が見分けに使う値（HP、進化段階、ワザと特性の名前、収録）も載せる。
 */

import type { CardDef } from "./engine.js";
import { loadGeneratedCards } from "./engine.js";

export interface CardBrief {
  name: string;
  kind: string;
  hp?: number;
  stage?: "basic" | "stage1" | "stage2";
  attacks?: string[];
  abilities?: string[];
  /** 同じ名前の 4 枚制限の外にあるので、組む画面が上限を変える。 */
  basicEnergy?: true;
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
  return {
    name: def.name,
    kind: def.kind,
    ...(def.kind === "pokemon"
      ? {
          hp: def.hp,
          stage: def.evolutionStage,
          attacks: def.attacks.map((attack) => attack.name),
          ...(def.abilities === undefined
            ? {}
            : { abilities: def.abilities.map((ability) => ability.name) }),
        }
      : {}),
    ...(def.kind === "energy" && def.basic ? { basicEnergy: true } : {}),
    ...(print === undefined || print.set === "" ? {} : { set: print.set }),
    ...(print?.number == null ? {} : { number: print.number }),
  };
}
