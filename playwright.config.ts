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
/** D1 と R2 の中身の保存先。手元で遊んだ `.wrangler/` を汚さないよう、実行ごとに捨てられる場所を渡す。 */
const STATE_DIR = mkdtempSync(join(tmpdir(), "poke-online-e2e-"));

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
     *
     * どのブラウザも同じ接続元から来るので、プレイヤーを作る速さの上限は外す。
     * カードの画像は切る。公式のサイトの応答でテストの結果を変えない。画像を出すテストは、
     * 設定と画像の応答を `page.route` で差し替えて確かめる。
     */
    command: [
      "node_modules/.bin/wrangler dev",
      `--ip 127.0.0.1 --port ${PORT}`,
      `--persist-to ${STATE_DIR}`,
      "--var ACCOUNT_BURST:0",
      "--var CARD_IMAGES:off",
    ].join(" "),
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
