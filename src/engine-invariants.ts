/**
 * エンジンが自己対戦へ掛けている不変条件を、対局ログの再生にも適用するための入口。
 *
 * `src/engine.ts` とは別にしてあるのは、こちらが**検証の道具だけが使う**入口であり、
 * 対戦の進行（`match.ts`、`hub.ts`）からは決して呼ばれないためである。
 * 検査は 1 局面あたり全ゾーンを走査するので、対戦中の経路へ入れると重い。
 */

import type { GameState } from "./engine.js";
import {
  checkCardConservation,
  checkChoiceVisibility,
  checkConditionExclusivity,
  checkHpGuessScratchLifetime,
  checkLegalMoves,
  checkNoPendingKnockout,
  zoneMap,
} from "../engine/src/testing/invariants.js";

/** 再生の開始局面から、カードの保存を見るための目印を取る。 */
export function initialCardIds(state: GameState): string[] {
  return [...zoneMap(state).keys()];
}

/**
 * 1 局面へ掛ける検査。`checkNoLeak` は乱数の種を要り、同じ性質は
 * `tests/leak.test.ts` が payload の側から見ているので、ここでは呼ばない。
 */
export function inspectState(state: GameState, initialCards: string[]): void {
  checkCardConservation(state, initialCards);
  checkLegalMoves(state);
  checkNoPendingKnockout(state);
  checkConditionExclusivity(state);
  checkChoiceVisibility(state);
  checkHpGuessScratchLifetime(state);
}
