/**
 * 対局ログを再生して検証する（`docs/spec/battle-server.md` 6.4 節）。
 *
 *   npx tsx tools/replay-verify.ts matches          R2 から落としたディレクトリを丸ごと
 *   npx tsx tools/replay-verify.ts matches/2026-09-21/<matchId>.json
 *
 * R2 には 1 局 1 オブジェクト（`matches/<日付>/<matchId>.json`）で置いてあり、中身は JSONL の 1 行と
 * 同じ形である。落とし方は `docs/deploy.md` にある。並べて 1 つにした `.jsonl` もそのまま読める。
 *
 * **ログの健全性の検査であると同時に、エンジンの検査である。**
 * 人間の対局は、一様ランダムの自己対戦が踏まない筋を踏む。毎晩これを回せば、
 * 実際に指された盤面が未知の誤りを探す標本になる。
 *
 * 終了コード: 0 = 全件通過 / 1 = 再生できないログか壊れた行がある / 2 = 読むものが無い
 *
 * **断った記録は「通らなかった」に数えない。** 種の読み方が変わる前のログは、これから先
 * ずっと再生できない（6.4 節）。それを失敗に数えると、この道具は恒久的に赤のままになり、
 * 本来見たい「未知の誤り」が埋もれる。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { registerPoolCards } from "../src/engine.js";
import { isMatchId } from "../src/history.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { REPLAY_SCHEMA_VERSION } from "../src/fingerprint.js";
import type { MatchRecord } from "../src/log.js";
import { replay } from "../src/replay.js";
import { engineIdentity } from "./engine-identity.js";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  process.stderr.write("検証するログのファイルかディレクトリを渡すこと\n");
  process.exit(2);
}

registerPoolCards();
const { commit, cardDataSha256 } = engineIdentity();
const fingerprint = { commit, cardDataSha256, replaySchemaVersion: REPLAY_SCHEMA_VERSION };

let records = 0;
let failed = 0;
let refused = 0;
let unfinished = 0;
let corrupt = 0;
let commitDiffers = 0;

for (const path of expand(targets)) {
  const lines = readFileSync(path, "utf8").split("\n");
  /**
   * そのファイルで中身のある最後の行。書きかけかどうかの判定に使う。
   * R2 のオブジェクトは書き終えたものしか読めないので、`.json` には書きかけが無い。
   */
  const lastWithContent = path.endsWith(".jsonl")
    ? lines.reduce((last, line, index) => (line.trim() === "" ? last : index), -1)
    : -1;
  for (const [lineNumber, line] of lines.entries()) {
    if (line.trim() === "") continue;
    /**
     * **切れた行があっても走査ごと止めない。** 1 行のために全部の日が読めなくなる。
     *
     * **`.jsonl` では、最後の行かどうかで扱いを分ける。** 追記している最中のファイルを読むと、
     * 書いている最中の行が途中までしか見えないことがある。それは正常な姿なので失敗に数えない。
     *
     * **後ろに行が続いていれば、書きかけではありえない。** その行のあとの追記が
     * 完了しているからである。そちらは壊れた記録なので 1 を返す。数えて要約に出すだけでは、
     * 緑の要約を人が読むことに頼ることになり、赤に埋もれるのと同じだけ見落とす。
     */
    let record: MatchRecord;
    try {
      record = JSON.parse(line) as MatchRecord;
    } catch {
      if (lineNumber === lastWithContent) {
        unfinished += 1;
      } else {
        corrupt += 1;
        process.stdout.write(`${path}:${lineNumber + 1} 解析できない\n`);
      }
      continue;
    }
    records += 1;

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
    if (result.failures.some((failure) => failure.kind === "schema-too-old")) {
      refused += 1;
      continue;
    }
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

if (unfinished > 0) process.stdout.write(`書きかけの最終行を ${unfinished} 行とばした\n`);
process.stdout.write(
  `${records} 件のうち ${refused} 件は版が古く再生しなかった。` +
    `残りを再生して ${failed} 件が通らなかった` +
    `（壊れた行 ${corrupt} 行、エンジンの commit が違うログ ${commitDiffers} 件）\n`,
);
process.exit(failed === 0 && corrupt === 0 ? 0 : 1);

function expand(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!statSync(path).isDirectory()) {
      files.push(path);
      continue;
    }
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      // 日付のディレクトリへ降りる。同じ場所にある別の JSON は読み込まない。
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && statSync(child).isDirectory()) {
        files.push(...expand([child]));
      } else if (
        /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry) ||
        (entry.endsWith(".json") && isMatchId(entry.slice(0, -".json".length)))
      ) {
        files.push(child);
      }
    }
  }
  return files;
}
