/**
 * 対局ログを再生して検証する（`docs/spec/battle-server.md` 6.4 節）。
 *
 *   npx tsx tools/replay-verify.ts data/matches/2026-09-21.jsonl
 *   npx tsx tools/replay-verify.ts data/matches          ディレクトリ配下の .jsonl を全部
 *
 * **ログの健全性の検査であると同時に、エンジンの検査である。**
 * 人間の対局は、一様ランダムの自己対戦が踏まない筋を踏む。毎晩これを回せば、
 * 実際に指された盤面が未知の誤りを探す標本になる。
 *
 * 終了コード: 0 = 全件通過 / 1 = 再生できないログがある / 2 = 読むものが無い
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerPoolCards } from "../src/engine.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { engineFingerprint } from "../src/fingerprint.js";
import type { MatchRecord } from "../src/log.js";
import { replay } from "../src/replay.js";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write("検証するログのファイルかディレクトリを渡すこと\n");
  process.exit(2);
}

registerPoolCards();
const fingerprint = engineFingerprint();

/**
 * エンジンを直せば起きうる食い違い。ログの側に落ち度は無い。
 *
 * ここに挙がっていないもの（`seed-commitment` と `card-data-mismatch`）は、
 * **エンジンを直しても起きない。** 前者はシャッフルが仕組まれていたという意味で、
 * 後者は違うカードデータで指されたという意味である。版の違いを口実にこの 2 つを
 * 見逃すと、エンジンを上げた日から先、対局ログ全体で公正さの検査が止まる。
 */
const ENGINE_DRIFT: ReadonlySet<string> = new Set([
  "first-player-mismatch",
  "choice-set-mismatch",
  "illegal-move",
  "no-move-available",
  "outcome-mismatch",
  "threw",
]);

let records = 0;
let failed = 0;
/**
 * エンジンの commit がログと違い、食い違いがエンジンを直せば起きうるものだけだった行。
 *
 * **これで 1 を返さない。** §6.3 は commit の食い違いを警告にとどめると決めているので、
 * 終了コードも同じ線を引く。数えて出しはするので、見たければ出力に出ている。
 */
let failedOnOlderEngine = 0;
let commitDiffers = 0;

for (const path of expand(targets)) {
  for (const [lineNumber, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    records += 1;

    let initialCards: string[] = [];
    let record: MatchRecord;
    let result;
    try {
      // **1 行の壊れで走査ごと止めない。** 残りの行と残りの日は読める。
      // 解析もここへ入れる。切れた行は `JSON.parse` の側で投げる。
      record = JSON.parse(line) as MatchRecord;
      result = replay(record, {
        fingerprint,
        inspect: (state, index) => {
          if (index === 0) initialCards = initialCardIds(state);
          inspectState(state, initialCards);
        },
      });
    } catch (error) {
      failed += 1;
      process.stdout.write(`${path}:${lineNumber + 1}\n  ${String(error)}\n`);
      continue;
    }

    if (result.engineCommitDiffers) commitDiffers += 1;
    if (result.failures.length === 0) continue;
    const onlyDrift = result.failures.every((failure) => ENGINE_DRIFT.has(failure.kind));
    if (result.engineCommitDiffers && onlyDrift) failedOnOlderEngine += 1;
    else failed += 1;
    process.stdout.write(`${path}:${lineNumber + 1} ${record.matchId}\n`);
    for (const failure of result.failures) {
      process.stdout.write(`  ${JSON.stringify(failure)}\n`);
    }
    // seed と手の数があれば、そのまま最小再現の材料になる。
    process.stdout.write(
      `  seed=${record.seed} 手数=${record.moves.length} 再生=${result.applied}\n`,
    );
  }
}

if (records === 0) {
  process.stderr.write("再生できるレコードが 1 件も無かった\n");
  process.exit(2);
}

process.stdout.write(
  `${records} 件を再生し、${failed} 件が通らなかった` +
    `（エンジンの commit が違うログ ${commitDiffers} 件。` +
    `うち通らなかった ${failedOnOlderEngine} 件は終了コードに入れない）\n`,
);
process.exit(failed === 0 ? 0 : 1);

function expand(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        // 対局ログは日付で切ってある。同じ場所の別の JSONL を読み込まない。
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) files.push(join(path, entry));
      }
    } else {
      files.push(path);
    }
  }
  return files;
}
