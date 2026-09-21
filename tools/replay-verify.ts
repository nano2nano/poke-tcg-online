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

let records = 0;
let failed = 0;
let commitDiffers = 0;

for (const path of expand(targets)) {
  for (const [lineNumber, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    records += 1;
    const record = JSON.parse(line) as MatchRecord;

    let initialCards: string[] = [];
    const result = replay(record, {
      fingerprint,
      inspect: (state, index) => {
        if (index === 0) initialCards = initialCardIds(state);
        inspectState(state, initialCards);
      },
    });

    if (result.engineCommitDiffers) commitDiffers += 1;
    if (result.failures.length === 0) continue;
    failed += 1;
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
    `（エンジンの commit が違うログ ${commitDiffers} 件）\n`,
);
process.exit(failed === 0 ? 0 : 1);

function expand(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (entry.endsWith(".jsonl")) files.push(join(path, entry));
      }
    } else {
      files.push(path);
    }
  }
  return files;
}
