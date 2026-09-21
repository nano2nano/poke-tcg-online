/**
 * `defId` から表示に要る値を引く表。
 *
 * 盤面の射影（`playerView`）はカードを `{instanceId, defId}` としか持たない。
 * 名前はカードの定義の側にあり、それは対戦ごとに変わらないので、
 * 局面に混ぜず一度だけ配る。クライアントは取得して持っておく。
 */

import { loadGeneratedCards } from "./engine.js";

export interface CardBrief {
  name: string;
  kind: string;
}

let index: Record<string, CardBrief> | null = null;

export function cardIndex(): Record<string, CardBrief> {
  if (index !== null) return index;
  const built: Record<string, CardBrief> = {};
  for (const def of loadGeneratedCards()) {
    built[def.defId] = { name: def.name, kind: def.kind };
  }
  index = built;
  return built;
}
