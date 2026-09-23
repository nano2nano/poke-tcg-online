/**
 * 1 対戦の実行時（`docs/spec/battle-server.md` 2 節）。
 *
 * 権威の `GameState` を持ち、座席から来た手を検査して `applyMove` へ通す。
 * 現在時刻は必ず引数で受け取る。時刻を読むのは配信層（`src/hub.ts`）1 箇所だけである。
 *
 * 座席と観戦者へ出る値の組み立て（`viewFor` / `spectatorViewFor` / `eventsFor` /
 * `legalMovesFor`）もここに置く。
 * **`state` と生の `events` を外へ返す関数をこのモジュールに作らないこと。** 射影を
 * 迂回する経路ができると、1 節の S-2 が守れなくなる。
 */

import {
  applyMove,
  createGame,
  legalMoves,
  movesEqual,
  opponent,
  playerView,
  projectEvents,
  spectatorView,
} from "./engine.js";
import type {
  DeckList,
  DomainEvent,
  GameOutcome,
  GameState,
  Move,
  Player,
  PlayerEvent,
  PlayerView,
  SpectatorView,
  Viewer,
} from "./engine.js";
import { consume, createClock, isTimedOut, moveRemainingMs, type Clock } from "./clock.js";
import { commitSeed, type SeedCommitment } from "./fingerprint.js";
import type { ClockView, RejectReason } from "./protocol.js";

export interface SeatInfo {
  /** サーバが発行した識別子。対戦をまたいで同じ人を指す（7.2 節）。 */
  playerId: string;
  displayName: string;
  /**
   * 対戦を始めた時点のレーティング。あとから座席と人を結び直すことはできないので、
   * ここで持たなければこの対戦には二度と付けられない。
   * 終わったあとのレーティングは、対戦の並びから導けるので持たない。
   */
  rating: number;
}

/**
 * 対戦の決着（2.3 節）。エンジンの `GameOutcome` とは別に持つ。
 * 投了と時間切れはルール上の敗北条件ではないので、`WinReason` へ足さない。
 */
export type MatchResult =
  | { kind: "normal"; winner: Player | null }
  | { kind: "concede"; winner: Player; conceded: Player }
  | { kind: "timeout"; winner: Player; timedOut: Player };

/** ログへ残す 1 手（6.2 節）。 */
export interface LoggedMove {
  move: Move;
  /** その手を選ぶのに掛かった時間。自己対戦では手に入らない量である。 */
  elapsedMs: number;
  /** 手の出どころ。今は人間だけだが、混ざったときに見分けられるよう欄を先に置く。 */
  source: "human";
  /**
   * そのとき規則が許していた手の数と、選ばれた手のその中での位置。
   *
   * どちらも再生で作り直せる。持つ理由は学習ではなく照合である（6.2 節）。
   * これが無いと、合法手の集合が変わった再生も黙って通る。
   */
  candidates: number;
  chosen: number;
  /**
   * 画面が実際に人へ見せた手の、`legalMoves` の中での位置。全部見せたなら null。
   *
   * これだけは再生で作り直せない（6.2 節）。見せなかった手まで「人が選ばなかった手」
   * として学ぶと、模倣も評価も歪む。クライアントの自己申告で、規則の判定には使わない。
   */
  offered: number[] | null;
}

export interface Match {
  readonly matchId: string;
  readonly seedCommitment: SeedCommitment;
  readonly decks: [DeckList, DeckList];
  readonly seats: [SeatInfo, SeatInfo];
  readonly seatTokens: [string, string];
  /**
   * 観戦に使う鍵（3.6 節）。座席ごとではなく対戦に 1 つで、両座席へ渡す。
   * 観戦者に見えるものは、どちらの座席も相手について見えているものに収まるので、
   * どちらが配っても相手に不利は生じない。
   */
  readonly spectatorToken: string;
  readonly startedAt: string;
  /** 先攻。seed から決まる導出値で、再生の入力ではない。先攻の偏りを測るために残す。 */
  readonly firstPlayer: Player;
  state: GameState;
  /** 1 手の適用ごとに 1 増える。`state.eventSeq` を流用しない（2.2 節）。 */
  version: number;
  clocks: [Clock, Clock];
  moves: LoggedMove[];
  /** 手番側が今の手を考え始めた時刻。 */
  turnStartedAtMs: number;
  result: MatchResult | null;
  endedAt: string | null;
}

export interface CreateMatchOptions {
  matchId: string;
  decks: [DeckList, DeckList];
  seats: [SeatInfo, SeatInfo];
  seatTokens: [string, string];
  spectatorToken: string;
  nowMs: number;
  startedAt: string;
  /** テストのために固定したいときだけ渡す。既定は 256 ビットの乱数。 */
  seedCommitment?: SeedCommitment;
  bankMs?: number;
}

export function createMatch(options: CreateMatchOptions): Match {
  const seedCommitment = options.seedCommitment ?? commitSeed();
  const created = createGame({ seed: seedCommitment.seed, decks: options.decks });
  return {
    matchId: options.matchId,
    seedCommitment,
    decks: options.decks,
    seats: options.seats,
    seatTokens: options.seatTokens,
    spectatorToken: options.spectatorToken,
    startedAt: options.startedAt,
    firstPlayer: firstPlayerOf(created.events),
    state: created.state,
    version: 0,
    clocks: [createClock(options.bankMs), createClock(options.bankMs)],
    moves: [],
    turnStartedAtMs: options.nowMs,
    result: null,
    endedAt: null,
  };
}

/**
 * 今、手を持っている座席（2.1 節）。
 *
 * 選択待ちがあれば最上段の `Choice` の owner、無ければ手番プレイヤーである。
 * **両者が同時に手を持つ状態は存在しない**ので、座席と手番の対応をサーバ側で別に持たない。
 */
export function toMove(match: Match): Player | null {
  if (match.result !== null || match.state.phase === "gameover") return null;
  return match.state.choices.at(-1)?.owner ?? match.state.turnPlayer;
}

export type SubmitOutcome =
  | { ok: true; events: DomainEvent[] }
  | { ok: false; reason: RejectReason };

/**
 * 手を 1 つ受理する。検査の順は 2.2 節のとおりで、入れ替えない。
 * 検査に落ちても `match` は変わらない（対戦は続く）。
 */
export function submitMove(
  match: Match,
  seat: Player,
  stateVersion: number,
  move: Move,
  nowMs: number,
  offered: number[] | null = null,
): SubmitOutcome {
  const mover = toMove(match);
  if (mover === null) return { ok: false, reason: "match-over" };
  if (mover !== seat) return { ok: false, reason: "not-your-turn" };
  if (stateVersion !== match.version) return { ok: false, reason: "stale-version" };

  const legal = legalMoves(match.state);
  const chosen = legal.findIndex((candidate) => movesEqual(candidate, move));
  if (chosen < 0) {
    return { ok: false, reason: "illegal-move" };
  }

  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  const applied = applyMove(match.state, move);
  match.state = applied.state;
  match.version += 1;
  match.moves.push({
    move,
    elapsedMs,
    source: "human",
    candidates: legal.length,
    chosen,
    offered: normalizeOffered(offered, legal.length),
  });
  match.clocks[seat] = consume(match.clocks[seat], elapsedMs);
  match.turnStartedAtMs = nowMs;

  if (match.state.phase === "gameover") {
    finish(match, { kind: "normal", winner: match.state.outcome?.winner ?? null }, nowMs);
  }
  return { ok: true, events: applied.events };
}

/** 投了する。`Move` ではないので `state` は動かない（2.3 節）。 */
export function concede(match: Match, seat: Player, nowMs: number): boolean {
  if (match.result !== null) return false;
  finish(match, { kind: "concede", winner: opponent(seat), conceded: seat }, nowMs);
  return true;
}

/**
 * 手番側の持ち時間が尽きていれば、その座席の時間切れ負けで終える（3.4 節）。
 *
 * 自動の手は指さない。その人が選んでいない手を、その人の座席の名前でログへ混ぜないためである。
 * 切断中も時計は流れるので、この判定に接続の生死は要らない。
 */
export function applyTimeout(match: Match, nowMs: number): boolean {
  const mover = toMove(match);
  if (mover === null) return false;
  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  if (!isTimedOut(match.clocks[mover], elapsedMs)) return false;
  finish(match, { kind: "timeout", winner: opponent(mover), timedOut: mover }, nowMs);
  return true;
}

/**
 * 座席 0 から見た結果。勝ち 1・引き分け 0.5・負け 0。レーティングの計算がこれを使う。
 *
 * 投了と時間切れも普通の勝敗として数える。規則上の敗北条件ではない（2.3 節）ことは
 * `matchResult.kind` が区別して持っているので、レーティングの側で分ける必要はない。
 */
export function scoreForSeatZero(result: MatchResult): number {
  if (result.kind === "normal" && result.winner === null) return 0.5;
  return result.winner === 0 ? 1 : 0;
}

/** エンジンが付けた勝敗。投了と時間切れでは対戦が途中なので null になる。 */
export function engineOutcome(match: Match): GameOutcome | null {
  return match.state.outcome;
}

export function viewFor(match: Match, seat: Player): PlayerView {
  return playerView(match.state, seat);
}

export function spectatorViewFor(match: Match): SpectatorView {
  return spectatorView(match.state);
}

export function eventsFor(events: DomainEvent[], viewer: Viewer): PlayerEvent[] {
  return projectEvents(events, viewer);
}

/**
 * 手番側の座席にだけ合法手を返す（4.1 節）。
 *
 * 帯域の話ではない。手番側の合法手にはその人の手札のカードが現れるので、
 * 相手へ送ると手札が割れる。
 */
export function legalMovesFor(match: Match, seat: Player): Move[] | null {
  return toMove(match) === seat ? legalMoves(match.state) : null;
}

export function clockView(match: Match, nowMs: number): ClockView {
  const mover = toMove(match);
  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  return {
    bankMs: [match.clocks[0].bankMs, match.clocks[1].bankMs],
    moveRemainingMs: mover === null ? null : moveRemainingMs(match.clocks[mover], elapsedMs),
    toMove: mover,
  };
}

function finish(match: Match, result: MatchResult, nowMs: number): void {
  match.result = result;
  match.endedAt = new Date(nowMs).toISOString();
}

/**
 * クライアントの自己申告を、記録に載せてよい形へ均す。
 *
 * 規則の判定には使わない値なので、壊れていても手を拒まない。合法手の範囲に無い位置と
 * 重複を落とし、全部見せたのと同じなら null（＝全部）へ畳む。
 */
function normalizeOffered(offered: number[] | null, candidates: number): number[] | null {
  if (offered === null) return null;
  const kept = [...new Set(offered)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < candidates)
    .sort((a, b) => a - b);
  return kept.length === candidates ? null : kept;
}

/** `game-started` が運ぶ先攻を読む。イベントの語彙が唯一の出どころである。 */
function firstPlayerOf(events: DomainEvent[]): Player {
  for (const event of events) {
    if (event.kind === "game-started") return event.firstPlayer;
  }
  throw new Error("createGame が game-started を出さなかった");
}
