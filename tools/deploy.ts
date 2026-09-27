/**
 * Cloudflare へ出す（`docs/deploy.md`）。`wrangler deploy` を呼ぶ前に、エンジンの状態を確かめる。
 *
 * 対局ログには、指したときのエンジンの commit を残す（`docs/spec/battle-server.md` 6.3 節）。
 * submodule に commit していない変更があると、その commit は中身を名乗れない。取れなければ
 * `unknown` が残る。どちらの記録も、あとで同じエンジンを用意して読み返すことができない。
 */

import { spawnSync } from "node:child_process";
import { engineHasLocalChanges, engineIdentity } from "./engine-identity.js";

const { commit } = engineIdentity();
if (commit === "unknown") {
  process.stderr.write("エンジンの commit が取れない。`npm run engine:sync` を先に実行すること\n");
  process.exit(1);
}
if (engineHasLocalChanges()) {
  process.stderr.write(
    "engine/ に commit していない変更がある。対局ログがその中身を名乗れないので出さない\n",
  );
  process.exit(1);
}

process.stdout.write(`エンジン ${commit} で出す\n`);
// `wrangler deploy` は `vite build` が書き出した設定（`dist/server/wrangler.json`）を読む。
// ビルドせずに呼ぶと、前にビルドした古い Worker か、カードデータを埋め込んでいない Worker が出る。
const built = spawnSync("npx", ["vite", "build"], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
const result = spawnSync("npx", ["wrangler", "deploy", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
