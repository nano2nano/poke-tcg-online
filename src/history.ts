/**
 * 済んだ対戦を読み返す（`docs/spec/battle-server.md` 6.6 節）。
 *
 * **読めるのは自分が指した対戦だけである。** 終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えると、それは対戦環境として成り立たない。
 *
 * 局面を保存しないので、盤面は `createGame` から指し直して作る。1 手ずつ辿るたびに初手から
 * やり直さないよう、局面のキャッシュをメモリにだけ置く（`ReplayCache`）。
 * 記録を引くのは `src/archive.ts` で、ここは引いた記録から盤面を作る。
 */

import { createHash } from "node:crypto";
import {
  applyMove,
  createGame,
  legalMoves,
  movesEqual,
  playerView,
  projectEvents,
} from "./engine.js";
import type { DomainEvent, GameState, Move, Player, PlayerEvent, PlayerView } from "./engine.js";
import {
  engineFingerprint,
  OLDEST_REPLAYABLE_SCHEMA_VERSION,
  type EngineFingerprint,
} from "./fingerprint.js";
import type { MatchRecord } from "./log.js";
import { seedCommitmentHolds } from "./replay.js";

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

/** 前へ戻るときは、手前のチェックポイントから指し直す。間隔はその手数の上限になる。 */
const CHECKPOINT_EVERY = 16;

const CACHED_REPLAYS = 32;

interface Checkpoint {
  applied: number;
  state: GameState;
  /** `applied` 手目で起きたこと。0 手目なら対戦の開始で起きたこと。 */
  events: DomainEvent[];
  /** `applied` 手目を指す直前の局面。0 手目なら null。 */
  before: GameState | null;
  playedMove: Move | null;
}

interface CachedReplay {
  /** 手数がキー。0 手目は必ずある。 */
  checkpoints: Map<number, Checkpoint>;
  /** 最後に描いた局面。1 手ずつ進むときは、ここから 1 手だけ指せば済む。 */
  latest: Checkpoint;
  /** 記録された手が指せなかった地点。見つかるまでは null。 */
  divergedAt: number | null;
}

/**
 * リプレイの局面のキャッシュ（6.6 節）。直近に読まれた対戦から順に残す。
 *
 * 無いと、1 手進めるたびに初手から指し直すことになる。同期で走るので、そのあいだ
 * 進行中の対戦の手も持ち時間のスイープも止まる。
 *
 * キーは対戦 ID ではなく、盤面を決める中身（seed、デッキ、手の列）のハッシュにする。
 * 対戦 ID で引くと、同じ ID で中身の違う記録に、前に読んだ別の記録の盤面を返しうる。
 */
export class ReplayCache {
  private readonly entries = new Map<string, CachedReplay>();

  constructor(private readonly capacity = CACHED_REPLAYS) {}

  entryFor(record: MatchRecord): CachedReplay {
    const key = contentKey(record);
    const found = this.entries.get(key);
    if (found !== undefined) {
      // `Map` は入れた順に並ぶ。読んだものを後ろへ回すと、先頭が最も長く読まれていないものになる。
      this.entries.delete(key);
      this.entries.set(key, found);
      return found;
    }
    const created = createGame({ seed: record.seed, decks: record.decks });
    const start: Checkpoint = {
      applied: 0,
      state: created.state,
      events: created.events,
      before: null,
      playedMove: null,
    };
    const entry: CachedReplay = {
      checkpoints: new Map([[0, start]]),
      latest: start,
      divergedAt: null,
    };
    this.entries.set(key, entry);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
    return entry;
  }
}

function contentKey(record: MatchRecord): string {
  const moves = record.moves.map((logged) => logged.move);
  return createHash("sha256")
    .update(JSON.stringify([record.seed, record.decks, moves]))
    .digest("hex");
}

const sharedCache = new ReplayCache();

function nearest(entry: CachedReplay, target: number): Checkpoint {
  let best = entry.checkpoints.get(0)!;
  for (
    let at = Math.floor(target / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    at >= 0;
    at -= CHECKPOINT_EVERY
  ) {
    const found = entry.checkpoints.get(at);
    if (found !== undefined) {
      best = found;
      break;
    }
  }
  const latest = entry.latest;
  return latest.applied <= target && latest.applied > best.applied ? latest : best;
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
  cache: ReplayCache = sharedCache,
): ReplayFrame {
  const readable = replayability(record, fingerprint);
  if (readable.kind !== "ok") {
    throw new Error(`読み返せない記録から盤面を作ろうとした: ${readable.kind}`);
  }
  // 手数は整数に丸める。丸めないと `ply: 1.5` を受け取り、盤面は 2 手目の後なのに
  // 応答には 1.5 と返る。数でないものだけ 0 にし、大きすぎるものは下の丸めに任せる。
  const asked = Number.isNaN(ply) ? 0 : Math.floor(ply);
  const target = Math.max(0, Math.min(asked, record.moves.length));
  const entry = cache.entryFor(record);
  // 指せない地点が分かっていれば、その先は指さずに、見つけたときと同じ答えを返す。
  const reachable = entry.divergedAt === null ? target : Math.min(target, entry.divergedAt);
  let at = nearest(entry, reachable);

  for (let index = at.applied; index < reachable; index++) {
    const logged = record.moves[index];
    if (logged === undefined) break;
    /**
     * **指す前に、いまのエンジンの合法手と突き合わせる。** 版が違えば、記録された手が
     * 合法でなくなりうる。そのまま `applyMove` へ渡すとエンジンが投げ、
     * エンドポイントはその例外メッセージをそのまま 400 で外へ出す。読む人に意味が無く、その対戦はここから先へ進めなくなる。
     * §6.3 は版の違いを警告にとどめると決めているので、止めるのはこの 1 局のこの地点だけにする。
     */
    if (!legalMoves(at.state).some((candidate) => movesEqual(candidate, logged.move))) {
      entry.divergedAt = index;
      break;
    }
    let next: ReturnType<typeof applyMove>;
    try {
      next = applyMove(at.state, logged.move);
    } catch (error) {
      // 合法手に在ったのに通らないのはエンジン側の話である。外へ例外メッセージは出さず、ここで止める。
      console.warn(`${record.matchId} の ${index} 手目を指せなかった:`, error);
      entry.divergedAt = index;
      break;
    }
    /**
     * 指せてから「直前の局面」を進める。先に進めると、**止まったときだけ 1 手ずれる。**
     * `playedMove` は 1 つ前の手のままなので、クライアントはその手で使ったカードを
     * 1 手あとの手札から探すことになり、名前が引けずにインスタンス ID がそのまま出る。
     */
    at = {
      applied: index + 1,
      state: next.state,
      events: next.events,
      before: at.state,
      playedMove: logged.move,
    };
    if (at.applied % CHECKPOINT_EVERY === 0) entry.checkpoints.set(at.applied, at);
  }
  entry.latest = at;
  // 指せない地点は、頼まれた手数がそこを越えたときだけ知らせる。キャッシュの有無で答えを変えないため。
  const divergedAt =
    entry.divergedAt !== null && target > entry.divergedAt ? entry.divergedAt : null;

  return {
    matchId: record.matchId,
    ply: at.applied,
    moveCount: record.moves.length,
    views: [playerView(at.state, 0), playerView(at.state, 1)],
    playedMove: at.playedMove,
    beforeViews: at.before === null ? null : [playerView(at.before, 0), playerView(at.before, 1)],
    events: [projectEvents(at.events, 0), projectEvents(at.events, 1)],
    engineCommitDiffers: record.engine.commit !== fingerprint.commit,
    divergedAt,
  };
}
