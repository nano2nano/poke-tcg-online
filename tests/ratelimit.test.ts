/** 呼ぶ速さの上限（`docs/spec/battle-server.md` 7.2 節）。 */

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_LIMIT, optionsFromVars } from "../src/app.js";
import { RateLimit } from "../src/ratelimit.js";

describe("呼ぶ速さの上限", () => {
  it("ためてあるぶんは続けて通り、そのあとは断る", () => {
    const limit = new RateLimit({ burst: 3, refillMs: 1_000, origins: 10 });
    expect([0, 0, 0].map(() => limit.take("あ", 0))).toEqual([true, true, true]);
    expect(limit.take("あ", 0)).toBe(false);
  });

  it("時間が経てば戻る", () => {
    const limit = new RateLimit({ burst: 2, refillMs: 1_000, origins: 10 });
    limit.take("あ", 0);
    limit.take("あ", 0);
    expect(limit.take("あ", 999)).toBe(false);
    expect(limit.take("あ", 1_000)).toBe(true);
    expect(limit.take("あ", 1_000)).toBe(false);
  });

  // 戻りすぎると、待っただけ撃てることになって上限の意味が無くなる。
  it("長く待っても、ためられるのは上限までである", () => {
    const limit = new RateLimit({ burst: 2, refillMs: 1_000, origins: 10 });
    limit.take("あ", 0);
    limit.take("あ", 0);
    expect([0, 0, 0].map(() => limit.take("あ", 1_000_000))).toEqual([true, true, false]);
  });

  it("送信元ごとに別々に数える", () => {
    const limit = new RateLimit({ burst: 1, refillMs: 1_000, origins: 10 });
    expect(limit.take("あ", 0)).toBe(true);
    expect(limit.take("い", 0)).toBe(true);
    expect(limit.take("あ", 0)).toBe(false);
  });

  /**
   * 覚える数に上限が無いと、送信元を変え続けるだけでメモリが伸びる。
   * **それは上限を置いた目的そのものを外す。**
   */
  it("覚える送信元の数に上限がある", () => {
    const limit = new RateLimit({ burst: 1, refillMs: 1_000, origins: 2 });
    limit.take("あ", 0);
    limit.take("い", 0);
    limit.take("う", 0);
    // 「あ」は溢れて忘れられたので、また 1 回ぶん通る。忘れる側に倒すのは、
    // 人が使うぶんを止めないためである。機械で回すぶんは、同じ送信元が残って当たる。
    expect(limit.take("あ", 0)).toBe(true);
    expect(limit.take("う", 0)).toBe(false);
  });
});

/**
 * 上限は既定で掛ける。接続元は Cloudflare が付ける値で数えるので、来た人全員が 1 つに
 * 数えられることはない。**読めない設定で上限を外さない。** 書き損じ 1 つで黙って外れる。
 */
describe("配置先の設定の読み取り", () => {
  it("置かなければ既定のまま", () => {
    expect(optionsFromVars({})).toEqual({});
    expect(optionsFromVars({ ACCOUNT_BURST: " " })).toEqual({});
  });

  it("0 なら上限を外し、数ならその回数まで通す", () => {
    expect(optionsFromVars({ ACCOUNT_BURST: "0" }).accountLimit).toBeNull();
    expect(optionsFromVars({ ACCOUNT_BURST: "2" }).accountLimit).toEqual({
      ...DEFAULT_ACCOUNT_LIMIT,
      burst: 2,
    });
    expect(optionsFromVars({ SILENCE_LIMIT_MS: "500" }).silenceLimitMs).toBe(500);
  });

  it("読めない設定は既定に倒し、警告を残す", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const value of ["たくさん", "-1", "1.5", "true"]) {
        expect(optionsFromVars({ ACCOUNT_BURST: value }), value).toEqual({});
        expect(optionsFromVars({ SILENCE_LIMIT_MS: value }), value).toEqual({});
      }
      // 0 秒で切ると、繋がった接続が次の定期処理で全部切れる。
      expect(optionsFromVars({ SILENCE_LIMIT_MS: "0" })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(9);
    } finally {
      warn.mockRestore();
    }
  });
});
