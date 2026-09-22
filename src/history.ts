/**
 * 済んだ対戦を読み返す（`docs/spec/battle-server.md` 6.6 節）。
 *
 * **読めるのは自分が指した対戦だけである。** 終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えると、それは対戦環境として成り立たない。
 *
 * 局面を持たないので、読み返すたびに `createGame` からやり直す。それで足りる速さの
 * 根拠は 6.6 節にある。索引は置かない。
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
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
 * その記録を、いまのエンジンでリプレイしてよいか（§6.3）。
 *
 * `cardDataSha256` の不一致は拒否し、`commit` の不一致は警告にとどめる。
 * 分ける理由は §6.3 にある。再生器（`src/replay.ts`）と同じ判断を返す。
 */
export type Replayability =
  | { kind: "ok"; engineCommitDiffers: boolean }
  | { kind: "card-data-mismatch"; expected: string; actual: string }
  | { kind: "unusable-seed" };

/**
 * エンジンへ渡せる `seed` か。数値と 1〜32 桁の 16 進だけが通る（エンジンの `RngSeed`）。
 *
 * **通らない値でエンジンを呼ばない。** JSONL は型を持たず、読み手は `as MatchRecord` で
 * 名前を付けているだけである。壊れた行をそのまま渡すとエンジンが投げ、エンドポイントは
 * 500 を返す。幅を変える前は `seed >>> 0` が何であれ 0 に均していたので、投げない代わりに
 * **黙って違う盤面**を見せていた。どちらも避けて、読めないと言う。
 */
function seedIsUsable(record: MatchRecord): boolean {
  const seed: unknown = record.seed;
  if (typeof seed === "number") return Number.isFinite(seed);
  return typeof seed === "string" && /^[0-9a-fA-F]{1,32}$/.test(seed);
}

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
  if (!seedIsUsable(record)) return { kind: "unusable-seed" };
  return { kind: "ok", engineCommitDiffers: record.engine.commit !== fingerprint.commit };
}

/**
 * 一覧に必要な項目だけを取り出したもの。キャッシュに載せるので、`moves` は持たない。
 * 1 局ぶんの JSONL は数十 KB あり、そのまま抱えるとログの総量ぶんメモリを使う。
 */
interface ListedMatch {
  matchId: string;
  startedAt: string;
  endedAt: string;
  playerIds: [string, string];
  displayNames: [string, string];
  matchResult: MatchResult;
  moveCount: number;
}

/**
 * 日ごとのファイルを、どこまで読んでキャッシュしたか。
 *
 * 追記しかしないログなので、いちど読んだバイト列は二度と変わらない。そのため
 * 追記ぶんだけを読み足せば、全体を読み直さずに最新の一覧を作れる。`consumed` を
 * 改行で終わる位置までに限るのは、追記の途中で読むと最後の行が欠けるためである。
 */
interface ListedDay {
  consumed: number;
  matches: ListedMatch[];
  /** この日のファイルにある対戦の識別子。無い対戦を名指しされたときに読まずに断るため。 */
  ids: Set<string>;
}

const LISTED = new Map<string, ListedDay>();

/**
 * 対局ログは日付で切ってあり、ファイル名がその日付になっている（6.5 節）。
 * 名前で絞るのは、同じディレクトリに置かれた別の JSONL を対局ログとして読まないためである。
 */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function isDayFile(name: string): boolean {
  return DAY_FILE.test(name);
}

/**
 * キャッシュに載せる対戦数の上限。超えたぶんは載せずに毎回読む。
 * ログは消えないので、上限を置かないと古い対戦のぶんが際限なく残る。
 */
const DEFAULT_LISTED_LIMIT = 50_000;
let listedLimit = DEFAULT_LISTED_LIMIT;

/**
 * 読んだ日を覚える。上限を超えたら**自分より古い日から**捨て、それでも収まらなければ
 * 自分を覚えない。
 *
 * **新しい日ほど残す。** いちばん伸びるのは今日のファイルで、伸びるたびに丸ごと
 * 読み直すことになれば、キャッシュを置いた意味が無くなる。
 *
 * 新しい日を捨てて古い日を残すと、**両方が毎回お互いを追い出す。** 古い日を読むたびに
 * 新しい日が落ち、次の呼び出しで新しい日を読み直し、それがまた古い日を落とす。
 * 全部の日が上限に収まらないときに、いちばん重い読み直しが毎回起きることになる。
 * 落ち着き先を「古い日だけが毎回読み直される」形にするために、捨てる向きを古い側に固定する。
 */
function rememberListed(path: string, day: ListedDay): void {
  LISTED.delete(path);
  const countOf = (key: string): number => LISTED.get(key)?.matches.length ?? 0;
  const newerTotal = [...LISTED.keys()]
    .filter((other) => other > path)
    .reduce((sum, key) => sum + countOf(key), 0);

  /**
   * **入らないなら、何も捨てずに自分だけ諦める。** 古い日を捨ててから自分も入らないと
   * 分かると、捨てた日と自分の両方を次から読み直すことになって、かえって重くなる。
   *
   * ただし、**いちばん新しい日だけは、1 日で上限を超えていても覚える。** そこがいちばん
   * 読まれて、いちばん伸びる。覚えないと毎回そのファイルを頭から読むことになり、上限を
   * 置いた目的（イベントループを止めない）と逆のことが起きる。上限が守るのはメモリで、
   * それは 1 日ぶんを上限にする形になる。
   */
  if (day.matches.length + newerTotal > listedLimit && newerTotal > 0) return;

  let total = countListed() + day.matches.length;
  for (const older of [...LISTED.keys()].sort()) {
    if (total <= listedLimit) break;
    if (older > path) break;
    total -= countOf(older);
    LISTED.delete(older);
  }
  LISTED.set(path, day);
}

/** テストと計測のためにキャッシュを捨てる。`limit` を渡すと、そのあとの上限も差し替える。 */
export function forgetListed(limit: number = DEFAULT_LISTED_LIMIT): void {
  LISTED.clear();
  listedLimit = limit;
}

/** そのプレイヤーが対戦したものを、新しい順に返す。 */
export function listMatches(dir: string, playerId: string): MatchSummary[] {
  const summaries: MatchSummary[] = [];
  for (const listed of readListed(dir)) {
    const seat = listed.playerIds[0] === playerId ? 0 : listed.playerIds[1] === playerId ? 1 : null;
    if (seat === null) continue;
    summaries.push({
      matchId: listed.matchId,
      startedAt: listed.startedAt,
      endedAt: listed.endedAt,
      seat,
      opponentName: listed.displayNames[seat === 0 ? 1 : 0],
      outcome: outcomeFor(listed.matchResult, seat),
      matchResult: listed.matchResult,
      moveCount: listed.moveCount,
    });
  }
  return summaries.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
}

/**
 * 日ごとのファイルを読んで、一覧に要る項目だけを返す。
 *
 * `/api/matches` は誰でも繰り返し呼べる。毎回すべての日を読み直すと、ログが増えるほど
 * イベントループが止まり、対戦中のプレイヤーの持ち時間が削られる（6.5 節）。
 */
function* readListed(dir: string): Generator<ListedMatch> {
  for (const day of listedDays(dir)) yield* day.matches;
}

/**
 * 日ごとのファイルを、キャッシュを最新にしながら順に返す。
 *
 * 読むファイルを日付名に限るのは `readRecords` と同じ条件である。**2 つが食い違うと、
 * 一覧には出るのに開けない対戦ができる。**
 */
function* listedDays(dir: string): Generator<ListedDay> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir).filter(isDayFile).sort()) {
    const path = join(dir, entry);
    const size = statSync(path).size;
    const cached = LISTED.get(path);
    // 縮んでいれば別物に差し替わっている。キャッシュを捨てて読み直す。
    const day =
      cached !== undefined && cached.consumed <= size
        ? cached
        : { consumed: 0, matches: [], ids: new Set<string>() };
    if (day.consumed < size) appendListed(path, day, size);
    /**
     * 読んだかどうかではなく、**差し替えたかどうか**で覚え直す。縮んだファイルが
     * 0 バイトだと読むものが無く、覚え直しもしないと、古いほうが上限を食ったまま残る。
     */
    if (day.consumed < size || day !== cached) rememberListed(path, day);
    yield day;
  }
}

/** その識別子の対戦が、どこかの日のファイルにあるか。 */
function isListed(dir: string, matchId: string): boolean {
  for (const day of listedDays(dir)) {
    if (day.ids.has(matchId)) return true;
  }
  return false;
}

function countListed(): number {
  let total = 0;
  for (const day of LISTED.values()) total += day.matches.length;
  return total;
}

/**
 * 前に読んだ続きから、改行で終わっているところまでを読み足す。
 *
 * **次に読む位置は、復号した文字列ではなくバイト列の側で数える。** 追記が多バイト文字の
 * 途中で落ちると、その端数は復号の時点で U+FFFD 1 文字（3 バイト）に化ける。文字列を
 * 測り直すとそのぶん位置が進みすぎ、境目をまたぐ 1 行が読めなくなって、その対戦が
 * 一覧から消える（`isListed` が `findMatch` を塞ぐので、リプレイも引けなくなる）。
 */
function appendListed(path: string, day: ListedDay, size: number): void {
  const length = size - day.consumed;
  const buffer = Buffer.alloc(length);
  const file = openSync(path, "r");
  let read = 0;
  try {
    read = readSync(file, buffer, 0, length, day.consumed);
  } finally {
    closeSync(file);
  }
  const chunk = buffer.subarray(0, read);
  const end = chunk.lastIndexOf(0x0a);
  if (end < 0) return;
  let broken = 0;
  for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const listed = listedOf(JSON.parse(line) as MatchRecord);
      day.matches.push(listed);
      day.ids.add(listed.matchId);
    } catch {
      broken++;
    }
  }
  // 追記の途中で落ちれば書きかけの行が残る。1 行のために全員の一覧を止めない。
  if (broken > 0) console.warn(`${path}: 読めない行を ${broken} 行とばした`);
  day.consumed += end + 1;
}

function listedOf(record: MatchRecord): ListedMatch {
  return {
    matchId: record.matchId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    playerIds: [record.seats[0].playerId, record.seats[1].playerId],
    displayNames: [record.seats[0].displayName, record.seats[1].displayName],
    matchResult: record.matchResult,
    moveCount: record.moves.length,
  };
}

/**
 * いま読み返されている対戦を数局だけ覚えておく。
 *
 * リプレイは 1 手進めるたびにここを通る。そのたびに全部の日を走査し直すと、
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
  // **すべての行に当たる識別子では走査しない。** 空文字はどの行にも含まれるので
  // 事前フィルタが素通りになり、全部の日を解析することになる。
  // 外から来る値の形はエンドポイントが確かめる（`isMatchId`）。ここはその最後のガードである。
  if (matchId.trim() === "") return null;
  const key = `${dir}\u0000${matchId}`;
  const opened = OPENED.get(key);
  // 覚えていても座席は毎回確かめる。読めるのは自分が指した対戦だけである（6.6 節）。
  if (opened !== undefined) return seatOf(opened, playerId) === null ? null : opened;

  /**
   * **無い対戦は、ログを読む前に断る。** 形だけ合っている識別子は誰でもいくらでも作れる。
   * 外れを 1 つずつ覚える手は効かない（識別子を変えれば何度でも外せる）が、
   * 一覧のキャッシュは**在る対戦の識別子**を持っているので、そちらに無ければ読む必要がない。
   */
  if (!isListed(dir, matchId)) return null;

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
 * ログを読みに行く。リプレイは 1 局を名指しで引くので、名指しになっていない値で
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

/**
 * 日付で切った JSONL を順に読む。索引が要る問い合わせが無いので、走査で足りる（6.5 節）。
 *
 * `needle` を渡すと、その文字列を含まない行は解析しない。 走査そのものは減らないが、
 * 1 行あたりの費用が `JSON.parse` から部分文字列の検索に落ちる。見つけたところで
 * 呼び手が抜ければ、そこで読むのも止まる。事前フィルタなので、当たった行は呼び手が確かめる。
 *
 * 読めない行は飛ばす。 追記の最中に落ちれば書きかけの行が残る。そこで例外を投げると、
 * 1 行のために全員の一覧とリプレイが止まる。読めた対戦を読めるままにするほうが要る。
 * 飛ばしたことは残しておく。黙って減ると、消えたのか壊れたのか分からない。
 */
function* readRecords(
  dir: string,
  needle?: string,
  order: "oldest-first" | "newest-first" = "oldest-first",
): Generator<MatchRecord> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  const days = readdirSync(dir).filter(isDayFile).sort();
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
