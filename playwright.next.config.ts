/**
 * いまの画面と同じ e2e を、作り直している画面（`/next/`）へ向ける。テストは画面を基準パスからの
 * 相対で開くので、baseURL を変えるだけで済む。入れ替えるまでは落ちてよい。
 */

import { defineConfig, devices } from "@playwright/test";
import { BASEPATH } from "./web/basepath.js";
import base, { ORIGIN } from "./playwright.config.js";

export default defineConfig({
  ...base,
  testMatch: "client.spec.ts",
  projects: [{ name: "next", use: { ...devices["Desktop Chrome"] } }],
  use: { ...base.use, baseURL: `${ORIGIN}${BASEPATH}/` },
});
