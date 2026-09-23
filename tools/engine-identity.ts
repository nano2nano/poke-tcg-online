/**
 * エンジンの同一性を、手元のファイルから求める（`docs/spec/battle-server.md` 6.3 節）。
 *
 * Worker の中にはリポジトリのファイルも `git` も無い。そこでビルドのときにここで求めた値を
 * 埋め込む（`tools/build-worker.ts`）。テスト（`vitest.config.ts`）と手元の道具も同じ関数を通すので、
 * 対局ログに残る値と、それを読み返す側の値が食い違わない。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "engine");

/** エンジンが実行時に読む正規カードデータ。Worker にはこの中身をそのまま埋め込む。 */
export const CARD_DATA_PATH = join(ENGINE, "data", "cards.generated.json");

export interface EngineIdentity {
  /** submodule が指す commit。commit していない変更があれば末尾に `-dirty` を付ける。取れなければ "unknown"。 */
  commit: string;
  cardDataSha256: string;
  /** ハッシュを取った中身そのもの。Worker に埋め込むのはこれで、別に読み直さない。 */
  cardDataText: string;
}

export function engineIdentity(): EngineIdentity {
  /**
   * **改行を LF にそろえてからハッシュを取る。** Windows で `core.autocrlf` を有効にして取ると、
   * submodule のファイルは CRLF で置かれる。そのまま取ると、同じカードデータなのに
   * ハッシュが変わり、ほかの環境で指した対戦がすべて「カードデータが違う」で読み返せなくなる。
   * JSON の文字列は生の改行を持てないので、そろえても中身は変わらない。
   */
  const cardDataText = readFileSync(CARD_DATA_PATH, "utf8").replace(/\r\n/g, "\n");
  return {
    commit: commitOf(),
    cardDataSha256: createHash("sha256").update(cardDataText).digest("hex"),
    cardDataText,
  };
}

/**
 * カードデータにある公式の cardID をすべて返す。画像の転送（仕様 3.7 節）が、頼まれた cardID が
 * カードの表にあるかを見るのに使う。Worker はカードデータを解析せずに済むよう、ビルドのときに埋め込む。
 */
export function cardIdsOf(cardDataText: string): string[] {
  const defs = JSON.parse(cardDataText) as { prints: { cardID: string }[] }[];
  return [...new Set(defs.flatMap((def) => def.prints.map((print) => print.cardID)))];
}

/**
 * `npm run deploy` を通さずに `wrangler deploy` を呼んでも、手を入れたエンジンで指した記録が
 * 手を入れる前の commit を名乗らないようにする。
 */
function commitOf(): string {
  const head = git("rev-parse", "HEAD");
  if (head === null) return "unknown";
  return engineHasLocalChanges() ? `${head}-dirty` : head;
}

/** submodule に commit していない変更があるか。あれば commit はその中身を名乗れない。 */
export function engineHasLocalChanges(): boolean {
  const status = git("status", "--porcelain");
  return status === null || status !== "";
}

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", ENGINE, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
