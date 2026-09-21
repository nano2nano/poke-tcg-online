/**
 * 済んだ対戦を読み返す（`docs/spec/battle-server.md` 6.6 節）。
 *
 * **読めるのは自分が指した対戦だけである。** 終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えると、それは対戦環境として成り立たない。
 *
 * 局面を持たないので、読み返すたびに `createGame` からやり直す。それで足りる速さの
 * 根拠は 6.6 節にある。索引は置かない。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyMove,
  createGame,
  legalMoves,
  movesEqual,
  playerView,
  projectEvents,
} from "./engine.js";
import type { GameState, Move, Player, PlayerEvent, PlayerView } from "./engine.js";
import { engineFingerprint, type EngineFingerprint } from "./fingerprint.js";
import type { MatchRecord } from "./log.js";
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
 * その記録を、いまのエンジンで読み返してよいか（§6.3）。
 *
 * `cardDataSha256` の不一致は拒否し、`commit` の不一致は警告にとどめる。
 * 分ける理由は §6.3 にある。再生器（`src/replay.ts`）と同じ判断を返す。
 */
export type Replayability =
  | { kind: "ok"; engineCommitDiffers: boolean }
  | { kind: "card-data-mismatch"; expected: string; actual: string };

export function replayability(
  record: MatchRecord,
  fingerprint: EngineFingerprint = engineFingerprint(),
): Replayability {
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
  const summaries: MatchSummary[] = [];
  for (const record of readRecords(dir, playerId)) {
    const seat = seatOf(record, playerId);
    if (seat === null) continue;
    summaries.push({
      matchId: record.matchId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      seat,
      opponentName: record.seats[seat === 0 ? 1 : 0].displayName,
      outcome: outcomeFor(record.matchResult, seat),
      matchResult: record.matchResult,
      moveCount: record.moves.length,
    });
  }
  return summaries.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/**
 * いま読み返されている対戦を数局だけ覚えておく。
 *
 * 読み返しは 1 手進めるたびにここを通る。そのたびに全部の日を走査し直すと、
 * **その間ずっと進行中の対戦の手も持ち時間のスイープも止まる。**
 *
 * これを置けるのは、追記しかしないログだからである。終わった対戦の 1 行は
 * 二度と書き変わらないので、覚えた値が古くならない。索引ではないので、
 * 貯めるのは開いている数局だけにする（6.5 節、6.6 節）。
 */
const OPENED = new Map<string, MatchRecord>();
const OPENED_LIMIT = 4;

/**
 * その人が指した 1 局を引く。指していない対戦は見つからないものとして扱う。
 *
 * 走査するときは、当たりうる行だけを解析する。 走査の範囲は変えないが、
 * `JSON.parse` は目当ての識別子を含む行にしか掛からない。新しい日から見るのは、
 * 読み返すのがたいてい最近の対戦だからである。
 */
export function findMatch(dir: string, playerId: string, matchId: string): MatchRecord | null {
  // すべての行に当たる識別子では走査しない。 空文字はどの行にも含まれるので
  // 事前フィルタが素通りになり、全部の日を解析することになる。しかも当たらないので
  // 覚えることもなく、送られるたびに同じ走査が起きる。
  // 外から来る値の形はエンドポイントが確かめる（`isMatchId`）。ここはその最後のガードである。
  if (matchId.trim() === "") return null;
  const key = `${dir}\u0000${matchId}`;
  const opened = OPENED.get(key);
  // 覚えていても座席は毎回確かめる。読めるのは自分が指した対戦だけである（6.6 節）。
  if (opened !== undefined) return seatOf(opened, playerId) === null ? null : opened;

  for (const record of readRecords(dir, matchId, "newest-first")) {
    if (record.matchId !== matchId) continue;
    remember(key, record);
    return seatOf(record, playerId) === null ? null : record;
  }
  return null;
}

/**
 * 外から来た値が、対戦の識別子の形をしているか。`randomUUID()` が出すものだけを受ける。
 *
 * **走査の入口を守るためのものなので、緩めない。** 形の確かめを通ったものだけが
 * ログを読みに行く。読み返しは 1 局を名指しで引くので、名指しになっていない値で
 * 走査を始めさせない。
 */
const MATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMatchId(value: string): boolean {
  return MATCH_ID.test(value);
}

function remember(key: string, record: MatchRecord): void {
  OPENED.set(key, record);
  // 入った順に捨てる。開いているものだけを持つので、厳密に数える価値はない。
  for (const old of OPENED.keys()) {
    if (OPENED.size <= OPENED_LIMIT) break;
    OPENED.delete(old);
  }
}

/** 覚えているものを捨てる。テストが同じディレクトリを作り直すときに使う。 */
export function forgetOpened(): void {
  OPENED.clear();
}

/**
 * `ply` 手まで進めた局面を返す。
 *
 * 返すのは `playerView` と `projectEvents` の結果だけである（1 節の S-2）。
 * 終わった対戦でも、生の `GameState` を外へ出す経路は作らない。
 *
 * 呼ぶ前に `replayability` を通すこと。カードの定義が変わった記録は、ここでは止まらない。
 */
export function frameAt(
  record: MatchRecord,
  ply: number,
  fingerprint: EngineFingerprint = engineFingerprint(),
): ReplayFrame {
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
    beforeState = result.state;
    try {
      result = applyMove(result.state, logged.move);
    } catch (error) {
      // 合法手に在ったのに通らないのはエンジン側の話である。外へ例外メッセージは出さず、ここで止める。
      console.warn(`${record.matchId} の ${index} 手目を指せなかった:`, error);
      divergedAt = index;
      break;
    }
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

/**
 * 日付で切った JSONL を順に読む。索引が要る問い合わせが無いので、走査で足りる（6.5 節）。
 *
 * `needle` を渡すと、その文字列を含まない行は解析しない。 走査そのものは減らないが、
 * 1 行あたりの費用が `JSON.parse` から部分文字列の検索に落ちる。見つけたところで
 * 呼び手が抜ければ、そこで読むのも止まる。事前フィルタなので、当たった行は呼び手が確かめる。
 *
 * 読めない行は飛ばす。 追記の最中に落ちれば書きかけの行が残る。そこで例外を投げると、
 * 1 行のために全員の一覧と読み返しが止まる。読めた対戦を読めるままにするほうが要る。
 * 飛ばしたことは残しておく。黙って減ると、消えたのか壊れたのか分からない。
 */
function* readRecords(
  dir: string,
  needle?: string,
  order: "oldest-first" | "newest-first" = "oldest-first",
): Generator<MatchRecord> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  const days = readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort();
  if (order === "newest-first") days.reverse();
  for (const entry of days) {
    let broken = 0;
    for (const line of readFileSync(join(dir, entry), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      if (needle !== undefined && !line.includes(needle)) continue;
      let record: MatchRecord;
      try {
        record = JSON.parse(line) as MatchRecord;
      } catch {
        broken++;
        continue;
      }
      yield record;
    }
    if (broken > 0) console.warn(`${entry}: 読めない行を ${broken} 行とばした`);
  }
}
