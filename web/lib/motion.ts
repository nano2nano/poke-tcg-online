/** カードが場所を移るときに動かす長さ。 */
export const MOVE_SECONDS = 0.3;
/** 動き終えたとみなすまでの長さ。描くのが少し遅れても間に合うよう、動かす長さに余裕を足す。 */
export const SETTLE_MS = MOVE_SECONDS * 1_000 + 100;
