/**
 * 座席とサーバのあいだを流れるメッセージ（`docs/spec/battle-server.md` 3.2 節）。
 *
 * この形が運ぶ値は、すべて `playerView` / `projectEvents` / 手番側だけの合法手のいずれかである
 * （同 4.1 節の S-2）。`GameState` と生の `DomainEvent` を運ぶ欄を作らない。
 */

import type { GameOutcome, Move, Player, PlayerEvent, PlayerView } from "./engine.js";
import type { MatchResult } from "./match.js";

/** 手を受理しなかった理由（2.2 節の検査 1〜3 に対応する）。 */
export type RejectReason = "not-your-turn" | "stale-version" | "illegal-move" | "match-over";

/** 座席から見た持ち時間。残りはミリ秒。 */
export interface ClockView {
  /** 座席ごとのバンクの残り。 */
  bankMs: [number, number];
  /** 手番側が今の手に使ってよい残り時間。手番が無ければ null。 */
  moveRemainingMs: number | null;
  /** 手番側の座席。決着後は null。 */
  toMove: Player | null;
}

export type ClientMessage =
  | { t: "hello"; seatToken: string }
  | {
      t: "move";
      stateVersion: number;
      move: Move;
      /**
       * 画面が実際に見せた手の、`legalMoves` の中での位置（6.2 節）。全部見せたなら省く。
       * 記録にだけ使う自己申告で、手を受理するかどうかの判断には入らない。
       */
      offered?: number[];
    }
  | { t: "concede" }
  | { t: "ping" };

/** 局面一式。`hello` の直後と、`stale-version` の応答として送る。 */
export interface SyncMessage {
  t: "sync";
  matchId: string;
  seat: Player;
  stateVersion: number;
  view: PlayerView;
  /** 手番側の座席にだけ配列が入る。他方は null（4.1 節）。 */
  legalMoves: Move[] | null;
  clock: ClockView;
  /** シャッフルの公正さのコミット（6.4 節）。対戦中に seed そのものは渡さない。 */
  seedCommit: string;
}

/** 1 手が適用された。両座席へ送る。 */
export interface DeltaMessage {
  t: "delta";
  stateVersion: number;
  events: PlayerEvent[];
  view: PlayerView;
  legalMoves: Move[] | null;
  clock: ClockView;
}

/** 対戦が終わった。ここで初めて seed を明かす（1 節の S-3）。 */
export interface EndedMessage {
  t: "ended";
  matchResult: MatchResult;
  /** エンジンが付けた勝敗。投了と時間切れでは null。 */
  outcome: GameOutcome | null;
  /** 16 進 32 桁。 */
  seed: string;
  seedNonce: string;
  view: PlayerView;
}

export type ServerMessage =
  | SyncMessage
  | DeltaMessage
  | EndedMessage
  | { t: "reject"; reason: RejectReason; stateVersion: number }
  | { t: "error"; message: string }
  | { t: "pong" };
