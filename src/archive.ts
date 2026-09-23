/**
 * 対局ログの保存先（`docs/spec/battle-server.md` 6.5 節）。
 *
 * 対局ログそのものは R2 に置く。 1 局を 1 つのオブジェクトにし、中身は JSONL の 1 行と同じ形にする。
 * 取ってきて並べればそのまま JSONL になり、`tools/replay-verify.ts` がそのまま読める。
 *
 * D1 の `matches` は索引で、R2 から作り直せる値だけを持つ。**行があることは、
 * その対戦をレーティングへ入れ終えたことも表す。** 行を足すのとレーティングを動かすのを
 * 1 つのトランザクションで行うので（`AccountStore.applyResult`）、片方だけが残ることはない。
 * 座席のプレイヤーが D1 に無ければ、行だけを足す（6.5 節）。
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types/index.ts";
import type { AccountStore } from "./accounts.js";
import type { Player } from "./engine.js";
import type { MatchRecord } from "./log.js";
import { scoreForSeatZero, type MatchResult } from "./match.js";

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

interface MatchRow {
  match_id: string;
  object_key: string;
  started_at: string;
  ended_at: string;
  seat0_player: string;
  seat1_player: string;
  seat0_name: string;
  seat1_name: string;
  match_result: string;
  move_count: number;
}

const PREFIX = "matches/";

/**
 * 終わった日を接頭辞にする。R2 は名前の順に並べて返すので、日ごとに順に取り出せる。
 * 日付は `endedAt` の UTC の日である。
 */
export function objectKey(record: MatchRecord): string {
  return `${PREFIX}${record.endedAt.slice(0, 10)}/${record.matchId}.json`;
}

const OBJECT_KEY = /^matches\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.json$/;

/** 突き合わせを済ませた日付を覚えておく欄の名前（`archive_state`）。 */
const RECONCILED_FROM = "reconciled-from";

/**
 * 突き合わせで、済んだ日付をどこまで戻すか。書いている途中で Durable Object が入れ替わると、
 * 前の日付の対戦があとから届きうる。その幅より十分に広く取る。
 */
const RECONCILE_MARGIN_DAYS = 2;

export class MatchArchive {
  /** 1 局ずつ順に残す。レーティングは前の対戦を入れた値から次を計算するので、並べないと取りこぼす。 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
    private readonly accounts: AccountStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 終わった対戦を残す。先に R2 へ書き、書けてから索引とレーティングへ入れる。
   *
   * **R2 へ書けなかった対戦では、レーティングを動かさない。** レーティングは対局ログから
   * 作り直せる、というのが 7.2 節である。記録に無い対戦でレーティングだけ動かすと、
   * どこから来た差か誰にも言えなくなる。
   *
   * 投げない。ここは持ち時間のスイープと WebSocket の処理から呼ばれる。
   */
  settle(record: MatchRecord): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.bucket.put(objectKey(record), `${JSON.stringify(record)}\n`, {
          httpMetadata: { contentType: "application/json" },
        });
      } catch (error) {
        console.error(
          `対局ログを書けなかった（${record.matchId}）。レーティングは動かさない:`,
          error,
        );
        return;
      }
      try {
        await this.index(record);
      } catch (error) {
        // R2 には残っている。索引とレーティングは、次に起きたときの突き合わせで入れ直す。
        console.error(`対局ログの索引に入れられなかった（${record.matchId}）:`, error);
      }
    });
  }

  /** その人が指した対戦を、新しい順に返す。 */
  async list(playerId: string): Promise<MatchSummary[]> {
    // 決着の直後に開いた一覧にも、その対戦が出るようにする。
    await this.queue;
    const { results } = await this.db
      .prepare(
        `SELECT * FROM matches WHERE seat0_player = ?1 OR seat1_player = ?1
         ORDER BY ended_at DESC, rowid DESC`,
      )
      .bind(playerId)
      .all<MatchRow>();
    return results.map((row) => {
      const seat: Player = row.seat0_player === playerId ? 0 : 1;
      const matchResult = JSON.parse(row.match_result) as MatchResult;
      return {
        matchId: row.match_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        seat,
        opponentName: seat === 0 ? row.seat1_name : row.seat0_name,
        outcome: outcomeFor(matchResult, seat),
        matchResult,
        moveCount: row.move_count,
      };
    });
  }

  /** その人が指した 1 局を引く。指していない対戦は、無い対戦と同じ null にする。 */
  async find(playerId: string, matchId: string): Promise<MatchRecord | null> {
    await this.queue;
    const row = await this.db
      .prepare("SELECT object_key, seat0_player, seat1_player FROM matches WHERE match_id = ?")
      .bind(matchId)
      .first<Pick<MatchRow, "object_key" | "seat0_player" | "seat1_player">>();
    if (row === null || (row.seat0_player !== playerId && row.seat1_player !== playerId)) {
      return null;
    }
    const object = await this.bucket.get(row.object_key);
    if (object === null) return null;
    const record = parseRecord(await object.text());
    /**
     * **読めた記録が、引いたはずの対戦であることを確かめる。** 索引は作り直せる値という
     * 建て付けなので信じきらない。食い違えば出るのは「読めない」ではなく別の対戦の盤面で、
     * 読む人にはそれが分からない。
     */
    if (record === null || record.matchId !== matchId) return null;
    return seatOf(record, playerId) === null ? null : record;
  }

  /**
   * R2 にあって索引に無い対戦を、索引とレーティングへ入れる。Durable Object が起きたときに呼ぶ。
   *
   * R2 へ書けて D1 へ書けなかった対戦を拾うためにある。見るのは前回済ませた日付から先だけで、
   * 済んだ日付は余裕を持たせて覚える（`RECONCILE_MARGIN_DAYS`）。
   *
   * 一覧を取るあいだは列に並ばない。 並ぶと、起きた直後の参加や一覧の要求がその間ずっと待たされる。
   * 列に並べるのは 1 局ずつ入れるところだけにする。
   */
  async reconcile(): Promise<void> {
    const state = await this.db
      .prepare("SELECT value FROM archive_state WHERE name = ?")
      .bind(RECONCILED_FROM)
      .first<{ value: string }>();
    const from = state?.value ?? null;
    const indexed = new Set(
      (
        await this.db
          .prepare("SELECT match_id FROM matches WHERE ended_day >= ?")
          .bind(from ?? "")
          .all<{ match_id: string }>()
      ).results.map((row) => row.match_id),
    );
    let missed = 0;
    for (const key of await this.keysFrom(from)) {
      const matchId = OBJECT_KEY.exec(key)?.[2];
      if (matchId === undefined || indexed.has(matchId)) continue;
      const object = await this.bucket.get(key);
      const record = object === null ? null : parseRecord(await object.text());
      if (record === null || record.matchId !== matchId) {
        console.error(`${key} は対局ログとして読めない。索引には入れない`);
        continue;
      }
      try {
        await this.enqueue(async () => {
          // 一覧を取ったあとに、決着の側が同じ対戦を入れていることがある。
          const already = await this.db
            .prepare("SELECT 1 FROM matches WHERE match_id = ?")
            .bind(matchId)
            .first();
          if (already !== null) return;
          await this.index(record);
          console.warn(`索引に無かった対戦を入れ直した（${matchId}）`);
        });
      } catch (error) {
        missed += 1;
        console.error(`対局ログの索引に入れられなかった（${matchId}）:`, error);
      }
    }
    // 入れられなかった対戦が残っていれば、次に起きたときにもう一度同じ日付から見る。
    if (missed > 0) return;
    const day = new Date(this.now() - RECONCILE_MARGIN_DAYS * 86_400_000).toISOString();
    await this.db
      .prepare(
        `INSERT INTO archive_state (name, value) VALUES (?1, ?2)
         ON CONFLICT (name) DO UPDATE SET value = ?2`,
      )
      .bind(RECONCILED_FROM, day.slice(0, 10))
      .run();
  }

  /** 決着を残す列が空くまで待つ。 */
  async settled(): Promise<void> {
    await this.queue;
  }

  private async index(record: MatchRecord): Promise<void> {
    const row = this.db
      .prepare(
        `INSERT INTO matches (match_id, object_key, ended_day, started_at, ended_at,
           seat0_player, seat1_player, seat0_name, seat1_name, match_result, move_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.matchId,
        objectKey(record),
        record.endedAt.slice(0, 10),
        record.startedAt,
        record.endedAt,
        record.seats[0].playerId,
        record.seats[1].playerId,
        record.seats[0].displayName,
        record.seats[1].displayName,
        JSON.stringify(record.matchResult),
        record.moves.length,
      );
    await this.accounts.applyResult(
      [record.seats[0].playerId, record.seats[1].playerId],
      scoreForSeatZero(record.matchResult),
      this.now(),
      [row],
    );
  }

  /** `from` の日付から先のキーを、名前の順に返す。`from` が null なら全部。 */
  private async keysFrom(from: string | null): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: PREFIX,
        // 日付そのものは、その日のキーより前に並ぶ。その日から含めて返る。
        ...(from === null ? {} : { startAfter: `${PREFIX}${from}` }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return keys;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function parseRecord(text: string): MatchRecord | null {
  try {
    return JSON.parse(text) as MatchRecord;
  } catch {
    return null;
  }
}

function seatOf(record: MatchRecord, playerId: string): Player | null {
  if (record.seats[0]?.playerId === playerId) return 0;
  if (record.seats[1]?.playerId === playerId) return 1;
  return null;
}

function outcomeFor(result: MatchResult, seat: Player): "win" | "loss" | "draw" {
  if (result.kind === "normal" && result.winner === null) return "draw";
  return result.winner === seat ? "win" : "loss";
}
