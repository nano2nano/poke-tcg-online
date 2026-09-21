/** 呼ぶ速さの上限（`docs/spec/battle-server.md` 7.2 節）。 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const dir = (): string => mkdtempSync(join(tmpdir(), "poke-rl-"));
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
 * 設定を読み違えると、**信用しているつもりで信用していない**状態になる。
 * `TRUST_PROXY=true` のような書き方は数に直すと `NaN` で、比較がすべて偽になる。
 */
describe("プロキシの数の読み取り", () => {
  it("数でない設定は 0 として扱い、警告を残す", async () => {
    const { createApp } = await import("../src/app.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.TRUST_PROXY = "true";
      const app = createApp({ logDir: dir(), accountDir: dir() });
      await app.close();
      expect(warn).toHaveBeenCalled();
    } finally {
      delete process.env.TRUST_PROXY;
      warn.mockRestore();
    }
  });
});

/**
 * 上限を掛けるかどうかは配置先で決まる。**既定で掛けると、プロキシの向こうを見分けられない
 * 設定のままの配置先で、来た人全員が 1 つとして数えられる。** クライアントは画面を開いた時点で
 * アカウントを作るので、それは全体がサイトを使えなくなるということである。
 */
describe("アカウントを作れる速さの設定", () => {
  const app = async (burst: string | undefined) => {
    const { createApp } = await import("../src/app.js");
    if (burst === undefined) delete process.env.ACCOUNT_BURST;
    else process.env.ACCOUNT_BURST = burst;
    const created = createApp({ logDir: dir(), accountDir: dir(), trustedProxies: 0 });
    const port = await new Promise<number>((resolve) => {
      created.http.listen(0, "127.0.0.1", () =>
        resolve((created.http.address() as AddressInfo).port),
      );
    });
    const create = (): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "いくつも" }),
      });
    return {
      create,
      close: async () => {
        delete process.env.ACCOUNT_BURST;
        await created.close();
      },
    };
  };

  it("設定を置かなければ掛からない", async () => {
    const { create, close } = await app(undefined);
    try {
      for (let i = 0; i < 12; i++) expect((await create()).status).toBe(200);
    } finally {
      await close();
    }
  });

  it("設定を置けば、そのぶんだけ通る", async () => {
    const { create, close } = await app("2");
    try {
      expect((await create()).status).toBe(200);
      expect((await create()).status).toBe(200);
      expect((await create()).status).toBe(429);
    } finally {
      await close();
    }
  });

  /** 読めない設定を「掛けた」と思い込むより、掛けずに警告を残すほうが気付ける。 */
  it("読めない設定は掛けず、警告を残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { create, close } = await app("たくさん");
    try {
      for (let i = 0; i < 5; i++) expect((await create()).status).toBe(200);
      expect(warn).toHaveBeenCalled();
    } finally {
      await close();
      warn.mockRestore();
    }
  });
});
