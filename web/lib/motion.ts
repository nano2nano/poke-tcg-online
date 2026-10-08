/**
 * カードが場所を移るときに動かす長さ。盤面の端から端まで動くこともあるので、ボタンなどの短い動き（0.2〜0.3 秒）より長く取る。
 */
export const MOVE_SECONDS = 0.45;
export const MOVE_MS = MOVE_SECONDS * 1_000;
/** 出だしを少し溜めてから動かし、着く前に緩める。出だしから速いと、どこから来たかを目で追えない。 */
export const MOVE_EASE = [0.4, 0, 0.2, 1] as const;
export const MOVE_EASING = `cubic-bezier(${MOVE_EASE.join(", ")})`;
/** 同じ場所から何枚も動くときに、1 枚ずつずらす間と、ずらす長さの上限。 */
export const STAGGER_MS = 50;
export const MAX_STAGGER_MS = 250;
/** 動き終えたとみなすまでの長さ。描くのが少し遅れても間に合うよう、動かす長さに余裕を足す。 */
export const SETTLE_MS = MOVE_MS + MAX_STAGGER_MS + 100;

/** 同じ場所から動く `order` 枚目を、動き始めるまで待たせる長さ。 */
export function staggerMs(order: number): number {
  return Math.min(order * STAGGER_MS, MAX_STAGGER_MS);
}
