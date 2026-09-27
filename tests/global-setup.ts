/**
 * Worker を起こすテスト（`tests/worker.ts`）の前に、`wrangler deploy` が出すのと同じものをビルドする。
 * テストはその出力（`dist/server/wrangler.json`）を読むので、ビルドせずに走らせると前の版の Worker を相手にする。
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function build(): void {
  // シェルの shim ではなく node で直に呼ぶ。Windows の `.bin/vite` は拡張子が無く、そのままでは起こせない。
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"],
    // Vitest は NODE_ENV を test にする。受け継ぐと React などが開発用のままビルドされ、本番と違うものを試す。
    { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
}

export default function setup(project: TestProject): void {
  build();
  project.onTestsRerun(build);
}
