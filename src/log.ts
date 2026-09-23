/**
 * 対局ログ（`docs/spec/battle-server.md` 6 節）。
 *
 * 唯一の情報源は seed と move 列である。局面もイベントも保存しない。エンジンの C-4
 * （同一 seed ＋同一 move 列 → 同一の状態列とイベント列）がこれを保証する。
 * どちらも再生で作り直せる値で、残すと桁が変わる。大きさの実測は 6.1 節にある。
 */

import type { DeckList, GameOutcome, Player } from "./engine.js";
import { engineFingerprint, type EngineFingerprint, type SeedShares } from "./fingerprint.js";
import {
  engineOutcome,
  type LoggedMove,
  type Match,
  type MatchResult,
  type SeatInfo,
} from "./match.js";

export interface MatchRecord {
  schemaVersion: number;
  matchId: string;
  engine: EngineFingerprint;
  /** 16 進 32 桁（9 節）。 */
  seed: string;
  /** 公開された `nonce`。これと `seed` の対応が、シャッフルの公正さの検証になる（6.4 節）。 */
  seedNonce: string;
  seedCommit: string;
  /**
   * 座席のシェアと、そのシェアのコミット（6.4 節）。どちらの座席もシェアを出さなかった対戦では
   * 欄ごと省く。省いた記録は、シェアを混ぜる前の記録と同じ読み方で検算できる。
   */
  seedShares?: SeedShares;
  seedShareCommits?: SeedShares;
  /** 先攻。seed から決まる導出値で、再生の入力ではない。先攻の偏りを測るために残す。 */
  firstPlayer: Player;
  decks: [DeckList, DeckList];
  seats: [SeatInfo, SeatInfo];
  startedAt: string;
  endedAt: string;
  moves: LoggedMove[];
  /** エンジンが付けた勝敗。投了と時間切れでは null。 */
  outcome: GameOutcome | null;
  matchResult: MatchResult;
}

export function toRecord(match: Match): MatchRecord {
  if (match.result === null || match.endedAt === null) {
    throw new Error(`まだ終わっていない対戦は記録できない: ${match.matchId}`);
  }
  return {
    schemaVersion: engineFingerprint().replaySchemaVersion,
    matchId: match.matchId,
    engine: engineFingerprint(),
    seed: match.seedCommitment.seed,
    seedNonce: match.seedCommitment.nonce,
    seedCommit: match.seedCommitment.commit,
    ...(match.seedShareCommits.every((commit) => commit === null)
      ? {}
      : { seedShares: match.seedCommitment.shares, seedShareCommits: match.seedShareCommits }),
    firstPlayer: match.firstPlayer,
    decks: match.decks,
    seats: match.seats,
    startedAt: match.startedAt,
    endedAt: match.endedAt,
    moves: match.moves,
    outcome: engineOutcome(match),
    matchResult: match.result,
  };
}
