/**
 * 済んだ対戦を読み返す（`docs/spec/battle-server.md` 6.6 節）。
 *
 * **読めるのは自分が指した対戦だけである。** 終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えると、それは対戦環境として成り立たない。
 *
 * 局面を持たないので、読み返すたびに `createGame` からやり直す。1 局まるごとでも
 * 50〜65 ミリ秒、1 手あたり 0.3 ミリ秒である（6.1 節）。索引もキャッシュも置かない。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyMove, createGame, playerView, projectEvents } from "./engine.js";
import type { GameState, Move, Player, PlayerEvent, PlayerView } from "./engine.js";
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
}

/** その人が指した対戦を、新しい順に返す。 */
export function listMatches(dir: string, playerId: string): MatchSummary[] {
  const summaries: MatchSummary[] = [];
  for (const record of readRecords(dir)) {
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

/** その人が指した 1 局を引く。指していない対戦は見つからないものとして扱う。 */
export function findMatch(dir: string, playerId: string, matchId: string): MatchRecord | null {
  for (const record of readRecords(dir)) {
    if (record.matchId !== matchId) continue;
    return seatOf(record, playerId) === null ? null : record;
  }
  return null;
}

/**
 * `ply` 手まで進めた局面を返す。
 *
 * **返すのは `playerView` と `projectEvents` の結果だけである**（1 節の S-2）。
 * 終わった対戦でも、生の `GameState` を外へ出す経路は作らない。
 */
export function frameAt(record: MatchRecord, ply: number): ReplayFrame {
  const target = Math.max(0, Math.min(ply, record.moves.length));
  let result = createGame({ seed: record.seed, decks: record.decks });
  let events = result.events;
  let playedMove: Move | null = null;
  let beforeState: GameState | null = null;

  for (let index = 0; index < target; index++) {
    const logged = record.moves[index];
    if (logged === undefined) break;
    beforeState = result.state;
    result = applyMove(result.state, logged.move);
    events = result.events;
    playedMove = logged.move;
  }

  return {
    matchId: record.matchId,
    ply: target,
    moveCount: record.moves.length,
    views: [playerView(result.state, 0), playerView(result.state, 1)],
    playedMove,
    beforeViews:
      beforeState === null ? null : [playerView(beforeState, 0), playerView(beforeState, 1)],
    events: [projectEvents(events, 0), projectEvents(events, 1)],
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

/** 日付で切った JSONL を順に読む。索引が要る問い合わせが無いので、走査で足りる（6.5 節）。 */
function* readRecords(dir: string): Generator<MatchRecord> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, entry), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      yield JSON.parse(line) as MatchRecord;
    }
  }
}
