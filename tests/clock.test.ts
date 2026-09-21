/** 持ち時間（`docs/spec/battle-server.md` 3.4 節）。 */

import { describe, expect, it } from "vitest";
import {
  BANK_MS,
  MOVE_ALLOWANCE_MS,
  consume,
  createClock,
  isTimedOut,
  moveRemainingMs,
} from "../src/clock.js";

describe("持ち時間", () => {
  it("1 手の猶予に収まるあいだはバンクが減らない", () => {
    expect(consume(createClock(), MOVE_ALLOWANCE_MS).bankMs).toBe(BANK_MS);
  });

  it("猶予を越えたぶんだけバンクが減る", () => {
    expect(consume(createClock(), MOVE_ALLOWANCE_MS + 5_000).bankMs).toBe(BANK_MS - 5_000);
  });

  it("バンクは 0 より下へ行かない", () => {
    expect(consume(createClock(1_000), MOVE_ALLOWANCE_MS + 9_000).bankMs).toBe(0);
  });

  it("残り時間は猶予とバンクの合計から、考えたぶんを引いた値である", () => {
    expect(moveRemainingMs(createClock(1_000), 500)).toBe(MOVE_ALLOWANCE_MS + 500);
  });

  it("猶予とバンクを使い切ったら時間切れになる", () => {
    const clock = createClock(1_000);
    expect(isTimedOut(clock, MOVE_ALLOWANCE_MS + 999)).toBe(false);
    expect(isTimedOut(clock, MOVE_ALLOWANCE_MS + 1_000)).toBe(true);
  });
});
