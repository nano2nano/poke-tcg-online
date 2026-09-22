/**
 * 済んだ対戦を読み返す（`docs/spec/battle-server.md` 6.6 節）。
 *
 * **読めるのは自分が指した対戦だけである。** 終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えると、それは対戦環境として成り立たない。
 *
 * 局面を持たないので、読み返すたびに `createGame` からやり直す。それで足りる速さの
 * 根拠は 6.6 節にある。**どの対戦がどこにあるかは索引に引く**（`src/match-index.ts`）。
 * 正本は JSONL のままで、索引はそこから作り直せる。
 */

import { closeSync, openSync, readSync } from "node:fs";
import {
  applyMove,
  createGame,
  legalMoves,
  movesEqual,
  playerView,
  projectEvents,
} from "./engine.js";
import type { GameState, Move, Player, PlayerEvent, PlayerView } from "./engine.js";
import {
  engineFingerprint,
  OLDEST_REPLAYABLE_SCHEMA_VERSION,
  type EngineFingerprint,
} from "./fingerprint.js";
import type { MatchRecord } from "./log.js";
import { listIndexed, locate, seatIn, syncIndex, type Located } from "./match-index.js";
import { seedCommitmentHolds } from "./replay.js";
import type { MatchResult } from "./match.js";

/** 一覧に出す 1 行。局面は含まない。 */
export interface MatchSummary {
  matchId: string;
  startedAt: string;
  endedAt: string;
  /** 読み手が座っていた側。 */
  seat: Player;
  opponentName: string;
  /** 読み手から見た結果。 */
  outcome: "win" | "loss" | "draw";
  matchResult: MatchResult;
  moveCount: number;
}

export interface ReplayFrame {
  matchId: string;
  ply: number;
  moveCount: number;
  /** 座席ごとの盤面。終わった対戦なので、当人には両側を見せる。 */
  views: [PlayerView, PlayerView];
  /** この手前の局面からこの局面へ移る手。`ply` が 0 なら null。 */
  playedMove: Move | null;
  /**
   * `playedMove` を指す直前の盤面。`ply` が 0 なら null。
   *
   * 手の見出しは、出したカードの名前で読む。そのカードは指したあとの手札にはもう無いので、
   * 指したあとの盤面からは引けない。1 手戻った盤面を画面が取り直すと往復が倍になるため、
   * ここで一緒に返す。射影を通す点は `views` と同じである。
   */
  beforeViews: [PlayerView, PlayerView] | null;
  /** その手で起きたこと。座席 0 から見た射影と座席 1 から見た射影。 */
  events: [PlayerEvent[], PlayerEvent[]];
  /** エンジンの版が記録と違うまま再生している。盤面は合っていないかもしれない（§6.3）。 */
  engineCommitDiffers: boolean;
  /**
   * 記録された手が、いまのエンジンでは合法でなくなった地点。無ければ null。
   *
   * ここから先は再現できない。**それでも手前までは読める**ので、断らずにここまでを返す。
   * 版の違いを一律で断らないのが §6.3 の決めで、再生器（`src/replay.ts`）も
   * 同じ地点を `illegal-move` として記録して止まる。
   */
  divergedAt: number | null;
}

/**
 * その記録を、いまのエンジンでリプレイしてよいか。
 *
 * 拒否するのは、盤面を描けてしまうのに**それが記録された対戦の盤面だと言えない**ときである。
 * `commit` の不一致だけは警告にとどめる。分ける理由は §6.3 にある。
 */
export type Replayability =
  | { kind: "ok"; engineCommitDiffers: boolean }
  | { kind: "schema-too-old"; recorded: number; oldest: number }
  | { kind: "seed-commitment-mismatch" }
  | { kind: "card-data-mismatch"; expected: string; actual: string };

export function replayability(
  record: MatchRecord,
  fingerprint: EngineFingerprint = engineFingerprint(),
): Replayability {
  // 種の読み方そのものが変わっている版は、盤面を 1 枚も描く前に断る（§6.4）。
  // 欠けている版番号も断る側へ倒す。`undefined < 3` は false なので、大小では素通りする。
  if (!(record.schemaVersion >= OLDEST_REPLAYABLE_SCHEMA_VERSION)) {
    return {
      kind: "schema-too-old",
      recorded: record.schemaVersion,
      oldest: OLDEST_REPLAYABLE_SCHEMA_VERSION,
    };
  }
  /**
   * **公開された `nonce` から `seed` を導き直せない記録は断る。**
   *
   * 上の版番号の判定は、境目を上げ忘れると黙って効かなくなる。こちらは導出そのものを
   * やり直すので、種の作り方が変わればどの版でも必ず食い違う。書き換えられた `seed` も
   * ここで止まる。再生器（`src/replay.ts`）はログの検査が仕事なので、同じ食い違いを
   * 止めずに `failures` へ載せて先へ進む。画面へ出すかどうかはこちらで決める。
   */
  if (!seedCommitmentHolds(record)) return { kind: "seed-commitment-mismatch" };
  if (record.engine.cardDataSha256 !== fingerprint.cardDataSha256) {
    return {
      kind: "card-data-mismatch",
      expected: record.engine.cardDataSha256,
      actual: fingerprint.cardDataSha256,
    };
  }
  return { kind: "ok", engineCommitDiffers: record.engine.commit !== fingerprint.commit };
}

/** その人が指した対戦を、新しい順に返す。 */
export function listMatches(dir: string, playerId: string): MatchSummary[] {
  syncIndex(dir);
  const summaries: MatchSummary[] = [];
  for (const indexed of listIndexed(dir, playerId)) {
    const seat = seatIn(indexed, playerId);
    if (seat === null) continue;
    summaries.push({
      matchId: indexed.matchId,
      startedAt: indexed.startedAt,
      endedAt: indexed.endedAt,
      seat,
      opponentName: indexed.displayNames[seat === 0 ? 1 : 0],
      outcome: outcomeFor(indexed.matchResult, seat),
      matchResult: indexed.matchResult,
      moveCount: indexed.moveCount,
    });
  }
  return summaries;
}

/**
 * その人が指した 1 局を引く。指していない対戦は見つからないものとして扱う。
 *
 * 索引が 1 行ぶんの位置と長さを持っているので、**読むのはその 1 行だけである。**
 * 走査していた頃は、リプレイを 1 手進めるたびに全部の日を読み直していた
 * （24,000 局で 1 局あたり 0.4 秒）。その間ずっと進行中の対戦の手も持ち時間のスイープも止まる。
 */
export function findMatch(dir: string, playerId: string, matchId: string): MatchRecord | null {
  if (matchId.trim() === "") return null;
  syncIndex(dir);
  const found = locate(dir, matchId);
  if (found === null) return null;
  const record = readLine(found);
  /**
   * **読んだ行が、引いたはずの対戦であることを確かめる。** 索引が指すのはバイトの位置なので、
   * ファイルが同じ大きさのまま別の中身に差し替わると、位置は合っていても別の対戦の行が読める。
   * 索引は消しても作り直せるという建て付けなので、ここは索引を信じきらない側に倒す。
   */
  if (record === null || record.matchId !== matchId) return null;
  return seatOf(record, playerId) === null ? null : record;
}

/** 索引が指す 1 行を読む。読めなければ null。 */
function readLine(found: Located): MatchRecord | null {
  const buffer = Buffer.alloc(found.length);
  let file: number;
  try {
    file = openSync(found.path, "r");
  } catch {
    // 索引に載せてから消えたファイル。「その対戦は無い」に倒す。
    return null;
  }
  let read = 0;
  try {
    read = readSync(file, buffer, 0, found.length, found.offset);
  } catch {
    return null;
  } finally {
    closeSync(file);
  }
  try {
    return JSON.parse(buffer.subarray(0, read).toString("utf8")) as MatchRecord;
  } catch {
    return null;
  }
}

/**
 * 外から来た値が、対戦の識別子の形をしているか。`randomUUID()` が出すものだけを受ける。
 *
 * 索引を引くようになったので、形の違う値で重い読み取りが起きることはもう無い。
 * それでも緩めないのは、**これが 404 と 400 を分ける線**だからである。形になっていない値は
 * 「その対戦は無い」ではなく「その要求は形が違う」で断る。
 */
const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMatchId(value: string): boolean {
  return MATCH_ID.test(value);
}

/**
 * `ply` 手まで進めた局面を返す。
 *
 * 返すのは `playerView` と `projectEvents` の結果だけである（1 節の S-2）。
 * 終わった対戦でも、生の `GameState` を外へ出す経路は作らない。
 *
 * **読み返せない記録からは盤面を作らず、投げる。** 呼ぶ順番だけに頼ると、断るはずの記録が
 * 1 回の呼び出しで「誤りの無い別の対戦」として出る。出たものが別の対戦だと、読む人には分からない。
 */
export function frameAt(
  record: MatchRecord,
  ply: number,
  fingerprint: EngineFingerprint = engineFingerprint(),
): ReplayFrame {
  const readable = replayability(record, fingerprint);
  if (readable.kind !== "ok") {
    throw new Error(`読み返せない記録から盤面を作ろうとした: ${readable.kind}`);
  }
  // 手数は整数に丸める。丸めないと `ply: 1.5` を受け取り、盤面は 2 手目の後なのに
  // 応答には 1.5 と返る。数でないものだけ 0 にし、大きすぎるものは下の丸めに任せる。
  const asked = Number.isNaN(ply) ? 0 : Math.floor(ply);
  const target = Math.max(0, Math.min(asked, record.moves.length));
  let result = createGame({ seed: record.seed, decks: record.decks });
  let events = result.events;
  let playedMove: Move | null = null;
  let beforeState: GameState | null = null;

  let applied = 0;
  let divergedAt: number | null = null;

  for (let index = 0; index < target; index++) {
    const logged = record.moves[index];
    if (logged === undefined) break;
    /**
     * **指す前に、いまのエンジンの合法手と突き合わせる。** 版が違えば、記録された手が
     * 合法でなくなりうる。そのまま `applyMove` へ渡すとエンジンが投げ、
     * エンドポイントはその例外メッセージをそのまま 400 で外へ出す。読む人に意味が無く、その対戦はここから先へ進めなくなる。
     * §6.3 は版の違いを警告にとどめると決めているので、止めるのはこの 1 局のこの地点だけにする。
     */
    if (!legalMoves(result.state).some((candidate) => movesEqual(candidate, logged.move))) {
      divergedAt = index;
      break;
    }
    /**
     * 指せてから `beforeState` を進める。先に進めると、**止まったときだけ 1 手ずれる。**
     * `playedMove` は 1 つ前の手のままなので、クライアントはその手で使ったカードを
     * 1 手あとの手札から探すことになり、名前が引けずにインスタンス ID がそのまま出る。
     */
    const before = result.state;
    let next: ReturnType<typeof applyMove>;
    try {
      next = applyMove(before, logged.move);
    } catch (error) {
      // 合法手に在ったのに通らないのはエンジン側の話である。外へ例外メッセージは出さず、ここで止める。
      console.warn(`${record.matchId} の ${index} 手目を指せなかった:`, error);
      divergedAt = index;
      break;
    }
    beforeState = before;
    result = next;
    events = result.events;
    playedMove = logged.move;
    applied = index + 1;
  }

  return {
    matchId: record.matchId,
    ply: applied,
    moveCount: record.moves.length,
    views: [playerView(result.state, 0), playerView(result.state, 1)],
    playedMove,
    beforeViews:
      beforeState === null ? null : [playerView(beforeState, 0), playerView(beforeState, 1)],
    events: [projectEvents(events, 0), projectEvents(events, 1)],
    engineCommitDiffers: record.engine.commit !== fingerprint.commit,
    divergedAt,
  };
}

function seatOf(record: MatchRecord, playerId: string): Player | null {
  if (record.seats[0].playerId === playerId) return 0;
  if (record.seats[1].playerId === playerId) return 1;
  return null;
}

function outcomeFor(result: MatchResult, seat: Player): "win" | "loss" | "draw" {
  if (result.kind === "normal" && result.winner === null) return "draw";
  return result.winner === seat ? "win" : "loss";
}
