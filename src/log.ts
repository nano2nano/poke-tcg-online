/**
 * 対局ログ（`docs/spec/battle-server.md` 6 節）。
 *
 * 唯一の情報源は seed と move 列である。局面もイベントも保存しない。エンジンの C-4
 * （同一 seed ＋同一 move 列 → 同一の状態列とイベント列）がこれを保証する。
 * どちらも再生で作り直せる値で、残すと桁が変わる。大きさの実測は 6.1 節にある。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeckList, GameOutcome, Player } from "./engine.js";
import { engineFingerprint, type EngineFingerprint } from "./fingerprint.js";
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
  seed: number;
  /** 公開された `nonce`。これと `seed` の対応が、シャッフルの公正さの検証になる（6.4 節）。 */
  seedNonce: string;
  seedCommit: string;
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

/** 既定の保存先。`createApp` もリプレイのためにこれを引く。 */
export const DEFAULT_LOG_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "matches",
);

/**
 * 日付で切った JSONL へ 1 行追記する（6.5 節）。データベースは置かない。
 *
 * 学習は先頭から順に読むだけで、索引を要する問い合わせは生きている対戦にしか無く、
 * それはメモリにある。
 */
export function appendRecord(record: MatchRecord, dir: string = DEFAULT_LOG_DIR): string {
  mkdirSync(dir, { recursive: true });
  const day = record.endedAt.slice(0, 10);
  const path = join(dir, `${day}.jsonl`);
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}
