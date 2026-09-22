/**
 * ブラウザから見た画面のテスト（`docs/spec/battle-server.md` 0 節「スコープ外」）。
 *
 * `public/app.js` にだけ自動テストが無く、回帰がここに集まっていた。`tests/` の vitest は
 * サーバの中を呼ぶので、画面の状態遷移（読み込みの競合、応答の追い越し、タブをまたぐ入り直し）
 * には触れない。ここはブラウザを実際に動かして、その層だけを見る。
 *
 * **文言では判定しない。** 画面の文字は仕様の対象外で、いま別に整理している最中でもある。
 * 当てるのは要素の id と、そこに出る個数・状態だけにする。
 */

import { defineConfig, devices } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8081;
/** サーバの書き込み先。リポジトリの `data/` を汚さないよう、実行ごとに捨てられる場所を渡す。 */
const DATA_DIR = mkdtempSync(join(tmpdir(), "poke-online-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  /**
   * 1 本のサーバを共有する。対戦は部屋ごとに分かれ、アカウントはブラウザの文脈ごとに
   * 別なので、並べても混ざらない。
   */
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    /**
     * **`npx` を挟まない。** `npx` は node を孫として起こすので、後片付けで `npx` だけが
     * 死んでサーバが生き残る。次の実行が古いサーバに当たって、嘘の結果を返す。
     */
    command: "node_modules/.bin/tsx src/main.ts",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      POKE_LOG_DIR: join(DATA_DIR, "matches"),
      POKE_ACCOUNT_DIR: DATA_DIR,
    },
  },
});
