/**
 * 座席とサーバのあいだを流れるメッセージ（`docs/spec/battle-server.md` 3.2 節）。
 *
 * この形が運ぶ値は、すべて `playerView` / `spectatorView` / `projectEvents` / 手番側だけの合法手の
 * いずれかである（同 4.1 節の S-2）。`GameState` と生の `DomainEvent` を運ぶ欄を作らない。
 */

import { z } from "zod";
import type {
  GameOutcome,
  Move,
  Player,
  PlayerEvent,
  PlayerView,
  SpectatorView,
} from "./engine.js";
import type { MatchResult, SeatInfo, SetupView } from "./match.js";
import type { SeedShares } from "./fingerprint.js";

/**
 * サーバがその座席を知らないことを、画面の文言に頼らずに伝える合図（3.3 節）。
 * 画面は、これを受け取ったときだけ覚えている座席を捨てる。
 */
export const SEAT_NOT_FOUND = "seat-not-found";

/**
 * 同じ座席に別の接続が繋がったので、この接続を閉じるという合図（3.3 節）。
 * 画面は切れた接続を繋ぎ直すので、これが無いと同じ座席を開いた 2 つのタブが互いを追い出し続ける。
 */
export const SEAT_REPLACED = "seat-replaced";

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

/**
 * 座席から届く 1 通（3.2 節）。**形を見るのはここだけである。**
 *
 * 通さずに配ると、`null` を 1 通送られただけで `t` を読む側が落ちる。手を進めかけたところで
 * 止まれば、その対戦の状態が半端に残る。座席に就いた相手は何度でも送れるので、
 * 「普通は来ない値」で済ませられない。
 */
export const clientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    /**
     * 3.2 節の表にある欄。**受け取るが、座席はこれで決めない。**
     * 座席は接続の `seatToken`（3.3 節）で決まっている。ここの値で決め直すと、
     * 他人の座席トークンを 1 通送るだけで座席を移れることになる。
     */
    seatToken: z.string().optional(),
  }),
  z.object({
    t: z.literal("move"),
    stateVersion: z.int().nonnegative(),
    /**
     * 手そのもの。**中身の形はここでは見ない。**
     *
     * `Move` はエンジンの型なので、ここへ写すとエンジンが増やすたびに 2 か所を直すことになり、
     * 写し忘れたぶんは「正しい手なのに断られる」形で出る。サーバは受けた手を `legalMoves` と
     * **構造ごと**突き合わせてから適用する（2.2 節の検査 3）ので、合法手と 1 欄でも違う object は
     * そこで落ちる。ここで見るのは object であることだけでよい。
     */
    move: z.record(z.string(), z.unknown()),
    /**
     * 画面が実際に見せた手の、`legalMoves` の中での位置（6.2 節）。全部見せたなら省く。
     * 記録にだけ使う自己申告で、手を受理するかどうかの判断には入らない。
     */
    offered: z.array(z.int().nonnegative()).optional(),
  }),
  /**
   * 対戦準備のバトル場とベンチを 1 度に出す（2.4 節）。手番でなくても送れる。
   * 値は手札のインスタンス ID で、合法かどうかはサーバがエンジンで確かめる。
   */
  z.object({
    t: z.literal("setup"),
    active: z.string().max(64),
    bench: z.array(z.string().max(64)).max(8),
  }),
  z.object({ t: z.literal("concede") }),
  z.object({ t: z.literal("ping") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** 局面一式。`hello` の直後、`stale-version` の応答、準備の答えを預かったとき（2.4 節）に送る。 */
export interface SyncMessage {
  t: "sync";
  matchId: string;
  seat: Player;
  stateVersion: number;
  view: PlayerView;
  /** 手番側の座席にだけ配列が入る。他方は null（4.1 節）。 */
  legalMoves: Move[] | null;
  /** 対戦準備でまとめて出せる候補か、出した答え（2.4 節）。準備の外では null。 */
  setup: SetupView | null;
  clock: ClockView;
  /** シャッフルの公正さのコミット（6.4 節）。対戦中に seed そのものは渡さない。 */
  seedCommit: string;
  /** 渡すかどうかは座席の側が決める（3.6 節）。 */
  spectatorToken: string;
}

/** 手が適用された。両座席へ送る。預かった準備の答えが続けて流れると、複数手ぶんになる（2.4 節）。 */
export interface DeltaMessage {
  t: "delta";
  stateVersion: number;
  events: PlayerEvent[];
  view: PlayerView;
  legalMoves: Move[] | null;
  setup: SetupView | null;
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
  /** 両座席のシェア。参加のときに受け取ったコミットと突き合わせる（6.4 節）。 */
  seedShares: SeedShares;
  view: PlayerView;
}

/**
 * 観戦者へ出す局面一式（3.6 節）。`seedCommit` を持たないのは、seed を明かす `ended` を
 * 観戦者へは送らず、照合のしようがないからである。`matchId` も持たない。対局ログを引くキーで、
 * 観戦トークンと一緒に座席の外へ出す理由が無い。
 */
export interface SpectatorSyncMessage {
  t: "spectator-sync";
  stateVersion: number;
  view: SpectatorView;
  clock: ClockView;
  /**
   * 公開 id は渡さない。観戦トークンは座席の外へ配られる値なので、それを持つだけで
   * 対局ログと人を結び付けられる形にしない。
   */
  seats: [SpectatorSeat, SpectatorSeat];
}

export type SpectatorSeat = Pick<SeatInfo, "displayName" | "rating">;

export interface SpectatorDeltaMessage {
  t: "spectator-delta";
  stateVersion: number;
  events: PlayerEvent[];
  view: SpectatorView;
  clock: ClockView;
}

/** seed は明かさない。seed からは両者のデッキの中身がすべて割れる（6.6 節）。 */
export interface SpectatorEndedMessage {
  t: "spectator-ended";
  matchResult: MatchResult;
  outcome: GameOutcome | null;
  view: SpectatorView;
}

export type ServerMessage =
  | SyncMessage
  | DeltaMessage
  | EndedMessage
  | SpectatorSyncMessage
  | SpectatorDeltaMessage
  | SpectatorEndedMessage
  | { t: "reject"; reason: RejectReason; stateVersion: number }
  | { t: "error"; message: string; code?: typeof SEAT_NOT_FOUND | typeof SEAT_REPLACED }
  /**
   * 席は取れているが、シェアがそろわず対戦がまだ始まっていない（6.4 節）。これが無いと、
   * 始まる前に切れた接続を、サーバへ繋がらなかったのと見分けられない。
   */
  | { t: "pending" }
  | { t: "pong" };
