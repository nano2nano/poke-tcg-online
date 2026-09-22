/**
 * テストのときだけ `node:sqlite` の代わりに読まれる（`vitest.config.ts` の `alias`）。
 *
 * `node:sqlite` は `node:` を付けたときだけ使える組み込みで、`builtinModules` には載らない。
 * vitest 2 系はその一覧で「外部の組み込みか」を決めるので、載っていないこの名前を
 * 自分で読み込もうとして失敗する（`node:sea` と `node:test` は名指しで例外にしてある）。
 * ここで `require` に渡せば変換を通らない。vitest を上げれば、この回り道は要らなくなる。
 */

import { createRequire } from "node:module";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
