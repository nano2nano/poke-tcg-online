/**
 * 持ち時間（`docs/spec/battle-server.md` 3.4 節）。
 *
 * 現在時刻はすべて引数で受け取る。この層が `Date.now()` を呼ばないのは、エンジンの D-3
 * （時刻を触らない）を機械的に守るためではなく、時計の進みをテストで書けるようにするためである。
 * 実際に時刻を読むのは配信層（`src/hub.ts`）1 箇所だけとする。
 */

/** 1 手に使ってよい時間。これを越えたぶんがバンクから引かれる。 */
export const MOVE_ALLOWANCE_MS = 60_000;

/** 座席ごとのバンク。使い切った座席は時間切れ負けになる。 */
export const BANK_MS = 15 * 60_000;

export interface Clock {
  bankMs: number;
}

export function createClock(bankMs: number = BANK_MS): Clock {
  return { bankMs };
}

/** `elapsedMs` だけ考えたあとのバンクを返す。1 手の猶予を越えたぶんだけ減る。 */
export function consume(clock: Clock, elapsedMs: number): Clock {
  const overrun = Math.max(0, elapsedMs - MOVE_ALLOWANCE_MS);
  return { bankMs: Math.max(0, clock.bankMs - overrun) };
}

/** 手番側が今の手に使ってよい残り時間。時間切れの判定（`isTimedOut`）もこれを見る。 */
export function moveRemainingMs(clock: Clock, elapsedMs: number): number {
  return Math.max(0, MOVE_ALLOWANCE_MS + clock.bankMs - elapsedMs);
}

/** 手番側が時間切れかどうか。切断中も時計は流れるので、この判定に接続の生死は要らない。 */
export function isTimedOut(clock: Clock, elapsedMs: number): boolean {
  return moveRemainingMs(clock, elapsedMs) <= 0;
}
