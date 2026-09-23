/**
 * 対局ログの再生と検証（`docs/spec/battle-server.md` 6.4 節）。
 *
 * **これはログの健全性の検査であると同時に、エンジンの検査である。**
 * 人間の対局は、一様ランダムの自己対戦が踏まない筋を踏む。エンジン側
 * `docs/roadmap-engine-completion.md` が「未知の誤りを測る手立て」として並べているものに、
 * 実際の対戦という標本が 1 つ加わる。
 */

import { applyMove, createGame, legalMoves, movesEqual } from "./engine.js";
import type { DomainEvent, GameOutcome, GameState, Player } from "./engine.js";
import {
  commitSeed,
  commitShare,
  noShares,
  OLDEST_REPLAYABLE_SCHEMA_VERSION,
} from "./fingerprint.js";
import type { MatchRecord } from "./log.js";

export type ReplayFailure =
  | { kind: "schema-too-old"; recorded: number; oldest: number }
  | { kind: "card-data-mismatch"; expected: string; actual: string }
  | { kind: "seed-commitment" }
  | { kind: "first-player-mismatch"; expected: Player; actual: Player }
  | { kind: "choice-set-mismatch"; index: number; expected: number; actual: number }
  | { kind: "illegal-move"; index: number; message: string }
  | { kind: "no-move-available"; index: number }
  | { kind: "outcome-mismatch"; expected: GameOutcome | null; actual: GameOutcome | null }
  | { kind: "threw"; index: number; message: string };

export interface ReplayResult {
  /**
   * 最後まで再生できたときの終局面。途中で止まったときはそこまでの局面。
   *
   * **再生を始めなかったときは null。** 断った記録から局面を作って返すと、一度も
   * 存在しなかった盤面を「途中まで」として渡すことになる。
   */
  state: GameState | null;
  /** 実際に適用できた手の数。 */
  applied: number;
  failures: ReplayFailure[];
  /** エンジンの commit がログと食い違うか。拒否の理由にはしない（6.3 節）。 */
  engineCommitDiffers: boolean;
}

export interface ReplayOptions {
  /** 今のエンジンの指紋。渡さないと同一性の検査を省く。 */
  fingerprint?: { commit: string; cardDataSha256: string };
  /** 全局面へ掛ける追加の検査。自己対戦の不変条件を渡す使い方を想定する。 */
  inspect?: (state: GameState, index: number) => void;
}

/**
 * ログ 1 行を再生する。確かめるのは 6.4 節の 4 つである。
 *
 * 1. すべての手が、その時点の `legalMoves` に含まれる。
 * 2. 終端の `outcome` がログの `outcome` と一致する。
 * 3. 呼び出し側が渡した検査が全局面で成り立つ。
 * 4. 先攻と、各手の合法手の数・選ばれた位置が、記録と一致する。
 *
 * 1 だけでは、合法手の集合そのものが変わった再生を止められない。4 がそれを見る。
 *
 * 再生を始める前に 2 つ断る。版が古すぎる記録（`OLDEST_REPLAYABLE_SCHEMA_VERSION`）と、
 * `cardDataSha256` が食い違う記録である。`commit` の不一致は警告にとどめる。
 * 分ける理由は 6.3 節にある。
 */
export function replay(record: MatchRecord, options: ReplayOptions = {}): ReplayResult {
  const failures: ReplayFailure[] = [];
  /**
   * **種の読み方が変わった版より前は、再生を始めない**（`OLDEST_REPLAYABLE_SCHEMA_VERSION`）。
   * 走らせても 0 手目から止まるが、出てくるのは「エンジンが変わった」という誤った読みである。
   * 欠けている版番号も断る側へ倒す。`undefined < 3` は false なので、大小では素通りする。
   */
  if (!(record.schemaVersion >= OLDEST_REPLAYABLE_SCHEMA_VERSION)) {
    return {
      state: null,
      applied: 0,
      failures: [
        {
          kind: "schema-too-old",
          recorded: record.schemaVersion,
          oldest: OLDEST_REPLAYABLE_SCHEMA_VERSION,
        },
      ],
      engineCommitDiffers: false,
    };
  }
  const expectedCardData = options.fingerprint?.cardDataSha256;
  if (expectedCardData !== undefined && expectedCardData !== record.engine.cardDataSha256) {
    return {
      state: null,
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
  const firstPlayer = firstPlayerOf(result.events);
  if (firstPlayer !== record.firstPlayer) {
    failures.push({
      kind: "first-player-mismatch",
      expected: record.firstPlayer,
      actual: firstPlayer,
    });
  }
  options.inspect?.(result.state, 0);

  let applied = 0;
  for (const [index, logged] of record.moves.entries()) {
    const legal = legalMoves(result.state);
    if (legal.length === 0) {
      failures.push({ kind: "no-move-available", index });
      break;
    }
    const chosen = legal.findIndex((candidate) => movesEqual(candidate, logged.move));
    if (chosen < 0) {
      failures.push({
        kind: "illegal-move",
        index,
        message: `${logged.move.type} がこの局面の合法手に無い`,
      });
      break;
    }
    if (legal.length !== logged.candidates) {
      failures.push({
        kind: "choice-set-mismatch",
        index,
        expected: logged.candidates,
        actual: legal.length,
      });
    }
    if (chosen !== logged.chosen) {
      failures.push({
        kind: "choice-set-mismatch",
        index,
        expected: logged.chosen,
        actual: chosen,
      });
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

/**
 * 公開された `nonce` とシェアから `seed` とコミットを導き直す（6.4 節）。
 *
 * **開いたシェアは、参加のときのコミットと突き合わせる。** 突き合わせないと、サーバが
 * シェアを差し替えて並びを選んでも、記録の中では辻褄が合ってしまう。コミットがあって
 * シェアが無いのは、期限までに開かなかった座席で、これは正しい記録である。
 */
export function seedCommitmentHolds(record: MatchRecord): boolean {
  const shares = record.seedShares ?? noShares();
  const commits = record.seedShareCommits ?? noShares();
  for (const seat of [0, 1] as const) {
    const share = shares[seat];
    if (share === null) continue;
    if (commits[seat] === null || commitShare(share) !== commits[seat]) return false;
  }
  const recomputed = commitSeed(record.seedNonce, shares);
  return recomputed.seed === record.seed && recomputed.commit === record.seedCommit;
}

/** `game-started` が運ぶ先攻。`src/match.ts` と同じ読み方をする。 */
function firstPlayerOf(events: DomainEvent[]): Player {
  for (const event of events) {
    if (event.kind === "game-started") return event.firstPlayer;
  }
  throw new Error("createGame が game-started を出さなかった");
}

function outcomesEqual(a: GameOutcome | null, b: GameOutcome | null): boolean {
  if (a === null || b === null) return a === b;
  return a.winner === b.winner && a.reason === b.reason;
}
