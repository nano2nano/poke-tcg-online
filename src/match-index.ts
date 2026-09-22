/**
 * 対局ログの索引（`docs/spec/battle-server.md` 6.5 節）。
 *
 * **正本は JSONL のままである。** ここが持つのは、その JSONL から作り直せる値だけで、
 * ファイルごと消しても対局ログは失われない。次に読んだときに頭から作り直す。
 *
 * 索引を置くのは、走査のままでは読み取りがイベントループを止めるからである。その重さは
 * 局数に比例して伸び、回している間は対戦の時計が進み続けるので、指している人が持ち時間を
 * 削られる。索引はこれを「その人が指した局数ぶん」と「1 行ぶんの `pread`」に落とす。
 * 置く前と置いたあとの実測は 6.5 節にある。
 *
 * **同期であることは変わらない。** 速くするのではなく、読む量を小さくする。
 */

import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MatchResult } from "./match.js";
import type { Player } from "./engine.js";

/**
 * 対局ログは日付で切ってあり、ファイル名がその日付になっている（6.5 節）。
 * 名前で絞るのは、同じディレクトリに置かれた別の JSONL を対局ログとして読まないためである。
 * **索引が読むファイルの集合は、1 局を引く側と同じでなければならない。** 食い違うと、
 * 一覧には出るのに開けない対戦ができる。
 */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** 索引のファイル名。日付の名前ではないので、対局ログとして読まれることはない。 */
const INDEX_FILE = "index.sqlite";

/**
 * 表の形を変えたら上げる。合わなければ索引を捨てて作り直す。
 * 作り直せる値しか置いていないので、移行は書かない。
 */
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE days (
  path TEXT PRIMARY KEY,
  consumed INTEGER NOT NULL
);
CREATE TABLE matches (
  match_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  byte_offset INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  seat0_player TEXT NOT NULL,
  seat1_player TEXT NOT NULL,
  seat0_name TEXT NOT NULL,
  seat1_name TEXT NOT NULL,
  match_result TEXT NOT NULL,
  move_count INTEGER NOT NULL
);
CREATE INDEX matches_by_seat0 ON matches (seat0_player, ended_at DESC);
CREATE INDEX matches_by_seat1 ON matches (seat1_player, ended_at DESC);
CREATE INDEX matches_by_path ON matches (path);
`;

/** 一覧に出す 1 局ぶん。局面も move 列も持たない。 */
export interface IndexedMatch {
  matchId: string;
  startedAt: string;
  endedAt: string;
  playerIds: [string, string];
  displayNames: [string, string];
  matchResult: MatchResult;
  moveCount: number;
}

/** その対戦の 1 行が、どのファイルのどこにあるか。 */
export interface Located {
  path: string;
  offset: number;
  length: number;
}

/** 索引が読んだ範囲の、1 行ぶんの形。`JSON.parse` の結果をここまで絞ってから入れる。 */
interface LoggedLine {
  matchId: string;
  startedAt: string;
  endedAt: string;
  seats: [{ playerId: string; displayName: string }, { playerId: string; displayName: string }];
  matchResult: MatchResult;
  moves: unknown[];
}

interface MatchRow {
  match_id: string;
  path: string;
  byte_offset: number;
  byte_length: number;
  started_at: string;
  ended_at: string;
  seat0_player: string;
  seat1_player: string;
  seat0_name: string;
  seat1_name: string;
  match_result: string;
  move_count: number;
}

/**
 * ディレクトリごとに 1 つ開いておく。`/api/matches` と `/api/replay` は繰り返し呼ばれるので、
 * 呼ばれるたびに開き直すと、索引を置いた意味がその分だけ減る。
 */
const OPEN = new Map<string, DatabaseSync>();

function indexPath(dir: string): string {
  return join(dir, INDEX_FILE);
}

/**
 * 索引を開く。読めなければ捨てて作り直す。
 *
 * **壊れた索引で止まらない。** 正本は JSONL なので、索引が読めないことは
 * 「まだ作っていない」と同じである。ここで投げると、索引のせいで対戦の記録が
 * 1 局も読めなくなる。
 */
function open(dir: string): DatabaseSync | null {
  const existing = OPEN.get(dir);
  if (existing !== undefined) return existing;
  // 置き場そのものが無いなら、索引も作らない。1 局も記録されていないのと同じ扱いにする。
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  let db: DatabaseSync;
  try {
    db = prepare(dir);
  } catch (error) {
    console.warn(`${indexPath(dir)}: 索引を読めなかったので作り直す:`, error);
    discardFiles(dir);
    db = prepare(dir);
  }
  OPEN.set(dir, db);
  return db;
}

function prepare(dir: string): DatabaseSync {
  const db = new DatabaseSync(indexPath(dir));
  /**
   * 索引は消しても作り直せるので、1 件ごとの `fsync` までは要らない。WAL と合わせて、
   * 落ちたときに失うのは直近の追記ぶんの**索引**だけで、次に読んだときに読み足す。
   */
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (version === SCHEMA_VERSION) return db;
  if (version !== 0) {
    db.close();
    discardFiles(dir);
    return prepare(dir);
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** WAL は本体のほかに 2 つファイルを作る。作り直すときは 3 つとも消す。 */
function discardFiles(dir: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${indexPath(dir)}${suffix}`, { force: true });
  }
}

/** 1 つ閉じる。サーバを閉じるときに、その置き場のぶんを手放す。 */
export function closeIndex(dir: string): void {
  OPEN.get(dir)?.close();
  OPEN.delete(dir);
}

/**
 * 開いている索引をすべて閉じる。テストが「起動し直した」状態を作るために使う。
 * 閉じても索引そのものは残るので、次に開いたときは続きから読み足す。
 */
export function closeIndexes(): void {
  for (const db of OPEN.values()) db.close();
  OPEN.clear();
}

/**
 * ログの追記ぶんを索引へ読み足す。
 *
 * 追記しかしないログなので、いちど読んだバイト列は二度と変わらない。ファイルごとに
 * 「どこまで読んだか」を索引の側に持たせると、**プロセスを起動し直しても読み直さずに済む。**
 * ここがメモリ上のキャッシュとの違いで、起動直後にログ全体を読む時間（実測で 24,000 局・1.6 秒）が
 * 消える。
 */
export function syncIndex(dir: string): void {
  const db = open(dir);
  if (db === null) return;
  const paths = readdirSync(dir)
    .filter((name) => DAY_FILE.test(name))
    .sort()
    .map((name) => join(dir, name));
  const cursors = new Map(
    (
      db.prepare("SELECT path, consumed FROM days").all() as { path: string; consumed: number }[]
    ).map((row) => [row.path, row.consumed] as const),
  );
  /**
   * **読み始めるまでに消えるファイルがある。** 古い日を移す運用は走っている最中にも起きるので、
   * 名前を並べたときに在ったファイルが、大きさを見るときには無いことがある。
   * ここで投げると、そのときだけ一覧とリプレイが 1 件も返せなくなる。
   */
  const sizes = new Map<string, number>();
  for (const path of paths) {
    try {
      sizes.set(path, statSync(path).size);
    } catch {
      continue;
    }
  }
  const alive = new Set(sizes.keys());
  const vanished = [...cursors.keys()].filter((path) => !alive.has(path));
  const behind = [...alive].filter((path) => (cursors.get(path) ?? 0) !== sizes.get(path));

  /**
   * **変わっていなければ 1 バイトも書かない。** `/api/matches` は誰でも繰り返し呼べる。
   * 呼ばれるたびに書き込みの処理を開くと、読むだけの要求でディスクを触ることになる。
   */
  if (vanished.length === 0 && behind.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const path of vanished) forgetDay(db, path);
    for (const path of behind) {
      catchUp(db, path, sizes.get(path) ?? 0, cursors.get(path) ?? 0);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * 消えた日のぶんを索引から落とす。
 *
 * ログを外へ移す運用（古い日を別の置き場へ移す、`logrotate` が消す）で消えたファイルの
 * ぶんが残ると、**一覧には出るのに開けない対戦**になる。
 */
function forgetDay(db: DatabaseSync, path: string): void {
  db.prepare("DELETE FROM matches WHERE path = ?").run(path);
  db.prepare("DELETE FROM days WHERE path = ?").run(path);
}

/**
 * 識別子を主キーに置くので、同じ対戦の行が 2 つあれば**あとの行が勝って 1 件になる。**
 * 記録する側は `randomUUID()` を振るのでこれは起きないが、ログを足し合わせる運用で
 * 重なったときに、一覧へ 2 件並べるよりは 1 件にするほうが読む人の役に立つ。
 */
const INSERT = `
INSERT OR REPLACE INTO matches (
  match_id, path, byte_offset, byte_length, started_at, ended_at,
  seat0_player, seat1_player, seat0_name, seat1_name, match_result, move_count
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function catchUp(db: DatabaseSync, path: string, size: number, cursor: number): void {
  let consumed = cursor;
  // 縮んでいれば別物に差し替わっている。索引を捨てて読み直す。
  if (consumed > size) {
    forgetDay(db, path);
    consumed = 0;
  }
  if (consumed >= size) return;

  const buffer = Buffer.alloc(size - consumed);
  let file: number;
  try {
    file = openSync(path, "r");
  } catch {
    // 大きさを見てから開くまでに消えた。次に呼ばれたときに、消えた日として落とす。
    return;
  }
  let read = 0;
  try {
    read = readSync(file, buffer, 0, buffer.length, consumed);
  } finally {
    closeSync(file);
  }
  const chunk = buffer.subarray(0, read);

  /**
   * **行の切れ目はバイト列の側で探す。** 追記が多バイト文字の途中で落ちると、その端数は
   * 復号の時点で U+FFFD 1 文字（3 バイト）に化ける。復号してから数えるとそのぶん位置が
   * 進みすぎ、境目をまたぐ 1 行が読めなくなる。索引は 1 行ぶんの位置と長さを持つので、
   * ここのずれは「読めない」では済まず、**別の対戦の行を読む**ことになる。
   */
  const insert = db.prepare(INSERT);
  let start = 0;
  let broken = 0;
  for (;;) {
    const end = chunk.indexOf(0x0a, start);
    if (end < 0) break;
    const line = chunk.subarray(start, end);
    const logged = parseLine(line);
    if (logged === null) {
      if (line.length > 0) broken++;
    } else {
      insert.run(
        logged.matchId,
        path,
        consumed + start,
        end - start,
        logged.startedAt,
        logged.endedAt,
        logged.seats[0].playerId,
        logged.seats[1].playerId,
        logged.seats[0].displayName,
        logged.seats[1].displayName,
        JSON.stringify(logged.matchResult),
        logged.moves.length,
      );
    }
    start = end + 1;
  }
  // 追記の途中で落ちれば書きかけの行が残る。1 行のために全員の一覧を止めない。
  if (broken > 0) console.warn(`${path}: 読めない行を ${broken} 行とばした`);
  // 改行で終わっているところまでを読んだことにする。書きかけの行は次に読み直す。
  db.prepare("INSERT OR REPLACE INTO days (path, consumed) VALUES (?, ?)").run(
    path,
    consumed + start,
  );
}

/** 索引に載せる欄だけを確かめる。ここを通らない行は、索引には入れずに読み飛ばす。 */
function parseLine(line: Buffer): LoggedLine | null {
  if (line.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Partial<LoggedLine>;
  if (typeof record.matchId !== "string" || record.matchId === "") return null;
  if (typeof record.startedAt !== "string" || typeof record.endedAt !== "string") return null;
  if (!Array.isArray(record.seats) || record.seats.length !== 2) return null;
  for (const seat of record.seats) {
    if (typeof seat?.playerId !== "string" || typeof seat?.displayName !== "string") return null;
  }
  if (record.matchResult === undefined || !Array.isArray(record.moves)) return null;
  return record as LoggedLine;
}

/** その人が指した対戦を、新しい順に返す。 */
export function listIndexed(dir: string, playerId: string): IndexedMatch[] {
  const db = open(dir);
  if (db === null) return [];
  const rows = db
    .prepare(
      `SELECT * FROM matches WHERE seat0_player = ? OR seat1_player = ?
       ORDER BY ended_at DESC, rowid DESC`,
    )
    .all(playerId, playerId) as unknown as MatchRow[];
  return rows.map((row) => ({
    matchId: row.match_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    playerIds: [row.seat0_player, row.seat1_player],
    displayNames: [row.seat0_name, row.seat1_name],
    matchResult: JSON.parse(row.match_result) as MatchResult,
    moveCount: row.move_count,
  }));
}

/** その対戦の 1 行がどこにあるか。索引に無ければ null。 */
export function locate(dir: string, matchId: string): Located | null {
  const db = open(dir);
  if (db === null) return null;
  const row = db
    .prepare("SELECT path, byte_offset, byte_length FROM matches WHERE match_id = ?")
    .get(matchId) as { path: string; byte_offset: number; byte_length: number } | undefined;
  if (row === undefined) return null;
  return { path: row.path, offset: row.byte_offset, length: row.byte_length };
}

/** 索引が知っている座席。`playerId` がどちらでもなければ null。 */
export function seatIn(indexed: IndexedMatch, playerId: string): Player | null {
  if (indexed.playerIds[0] === playerId) return 0;
  if (indexed.playerIds[1] === playerId) return 1;
  return null;
}
