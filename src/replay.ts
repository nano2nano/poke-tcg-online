/**
 * 対局ログの再生と検証（`docs/spec/battle-server.md` 6.4 節）。
 *
 * **これはログの健全性の検査であると同時に、エンジンの検査である。**
 * 人間の対局は、一様ランダムの自己対戦が踏まない筋を踏む。エンジン側
 * `docs/roadmap-engine-completion.md` が「未知の誤りを測る手立て」として並べているものに、
 * 実際の対戦という標本が 1 つ加わる。
 */

import { applyMove, createGame, legalMoves, movesEqual } from "./engine.js";
import type { GameOutcome, GameState } from "./engine.js";
import { commitSeed } from "./fingerprint.js";
import type { MatchRecord } from "./log.js";

export type ReplayFailure =
  | { kind: "card-data-mismatch"; expected: string; actual: string }
  | { kind: "seed-commitment" }
  | { kind: "illegal-move"; index: number; message: string }
  | { kind: "no-move-available"; index: number }
  | { kind: "outcome-mismatch"; expected: GameOutcome | null; actual: GameOutcome | null }
  | { kind: "threw"; index: number; message: string };

export interface ReplayResult {
  /** 最後まで再生できたときの終局面。失敗したときは途中の局面。 */
  state: GameState;
  /** 実際に適用できた手の数。 */
  applied: number;
  failures: ReplayFailure[];
  /** エンジンの commit がログと食い違うか。拒否の理由にはしない（6.3 節）。 */
  engineCommitDiffers: boolean;
}

export interface ReplayOptions {
  /** 今のエンジンの刻印。渡さないと同一性の検査を省く。 */
  fingerprint?: { commit: string; cardDataSha256: string };
  /** 全局面へ掛ける追加の検査。自己対戦の不変条件を渡す使い方を想定する。 */
  inspect?: (state: GameState, index: number) => void;
}

/**
 * ログ 1 行を再生する。確かめるのは 6.4 節の 3 つである。
 *
 * 1. すべての手が、その時点の `legalMoves` に含まれる。
 * 2. 終端の `outcome` がログの `outcome` と一致する。
 * 3. 呼び出し側が渡した検査が全局面で成り立つ。
 *
 * `cardDataSha256` の不一致は再生を拒否する（`defId` が別のカードを指しうる）。
 * `commit` の不一致は警告にとどめる。エンジンの修理が挙動を変えるのは踏んだ対戦だけで、
 * 踏んだかどうかは再生すれば必ず分かる。版を理由に一律で捨てると、直した誤りに
 * 触れていない大多数の対戦まで失う。
 */
export function replay(record: MatchRecord, options: ReplayOptions = {}): ReplayResult {
  const failures: ReplayFailure[] = [];
  const expectedCardData = options.fingerprint?.cardDataSha256;
  if (expectedCardData !== undefined && expectedCardData !== record.engine.cardDataSha256) {
    return {
      state: createGame({ seed: record.seed, decks: record.decks }).state,
      applied: 0,
      failures: [
        {
          kind: "card-data-mismatch",
          expected: record.engine.cardDataSha256,
          actual: expectedCardData,
        },
      ],
      engineCommitDiffers: false,
    };
  }

  if (!seedCommitmentHolds(record)) failures.push({ kind: "seed-commitment" });

  let result = createGame({ seed: record.seed, decks: record.decks });
  options.inspect?.(result.state, 0);

  let applied = 0;
  for (const [index, logged] of record.moves.entries()) {
    const legal = legalMoves(result.state);
    if (legal.length === 0) {
      failures.push({ kind: "no-move-available", index });
      break;
    }
    if (!legal.some((candidate) => movesEqual(candidate, logged.move))) {
      failures.push({
        kind: "illegal-move",
        index,
        message: `${logged.move.type} がこの局面の合法手に無い`,
      });
      break;
    }
    try {
      result = applyMove(result.state, logged.move);
    } catch (error) {
      failures.push({ kind: "threw", index, message: (error as Error).message });
      break;
    }
    applied += 1;
    try {
      options.inspect?.(result.state, index + 1);
    } catch (error) {
      failures.push({ kind: "threw", index: index + 1, message: (error as Error).message });
      break;
    }
  }

  if (applied === record.moves.length) {
    const actual = result.state.outcome;
    if (!outcomesEqual(actual, record.outcome)) {
      failures.push({ kind: "outcome-mismatch", expected: record.outcome, actual });
    }
  }

  return {
    state: result.state,
    applied,
    failures,
    engineCommitDiffers:
      options.fingerprint !== undefined && options.fingerprint.commit !== record.engine.commit,
  };
}

/** 公開された `nonce` から `seed` とコミットを導き直す（6.4 節）。 */
export function seedCommitmentHolds(record: MatchRecord): boolean {
  const recomputed = commitSeed(record.seedNonce);
  return recomputed.seed === record.seed && recomputed.commit === record.seedCommit;
}

function outcomesEqual(a: GameOutcome | null, b: GameOutcome | null): boolean {
  if (a === null || b === null) return a === b;
  return a.winner === b.winner && a.reason === b.reason;
}
