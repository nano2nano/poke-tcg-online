/**
 * 対局ログの保存先（`docs/spec/battle-server.md` 6.5 節、6.6 節）。
 *
 * 対局ログそのものは R2 の 1 局 1 オブジェクトで、D1 の索引はそこから作り直せる。索引に行があることは、
 * その対戦がレーティングに入ったことも表す。ここが崩れると、記録に無い対戦でレーティングが
 * 動くか、記録にある対戦がどこからも引けなくなる。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types/index.ts";
import { AccountStore, INITIAL_RATING, K_FACTOR } from "../src/accounts.js";
import { MatchArchive, objectKey } from "../src/archive.js";
import { toRecord, type MatchRecord } from "../src/log.js";
import { concede } from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";
import { startStorage } from "./worker.js";

let storage: Awaited<ReturnType<typeof startStorage>>;
let db: D1Database;
let bucket: R2Bucket;
/** 1 局だけ指しておき、識別子と座席と日付を差し替えて使い回す。 */
let base: MatchRecord;

beforeAll(async () => {
  storage = await startStorage();
  db = storage.db;
  bucket = storage.archive;
  ensureCards();
  const played = playToEnd(newMatch("archive"), 7).match;
  if (played.result === null) concede(played, 1, 1);
  base = toRecord(played);
});

afterAll(async () => {
  await storage.close();
});

interface Setup {
  accounts: AccountStore;
  archive: MatchArchive;
  /** 作ったプレイヤーの識別子。 */
  players: string[];
}

async function setup(count = 2): Promise<Setup> {
  const accounts = new AccountStore(db);
  const archive = new MatchArchive(db, bucket, accounts);
  const players = [];
  for (let i = 0; i < count; i++)
    players.push((await accounts.create(`p${i}`, 0)).account.playerId);
  return { accounts, archive, players };
}

/** 座席 0 が勝った 1 局。日付を渡さなければ今日に終わったことにする。 */
function recordOf(
  players: [string, string],
  overrides: Partial<Pick<MatchRecord, "endedAt" | "matchResult">> = {},
): MatchRecord {
  const at = new Date().toISOString();
  return {
    ...base,
    matchId: randomUUID(),
    startedAt: at,
    endedAt: at,
    matchResult: { kind: "concede", winner: 0, conceded: 1 },
    seats: [
      { ...base.seats[0], playerId: players[0], displayName: `名-${players[0]}` },
      { ...base.seats[1], playerId: players[1], displayName: `名-${players[1]}` },
    ],
    ...overrides,
  };
}

function pair(players: string[]): [string, string] {
  return [players[0]!, players[1]!];
}

/** 1 回目の `batch` だけ落ちる D1。R2 には書けて D1 には書けなかった場合を作る。 */
function batchFailsOnce(target: D1Database): D1Database {
  let failed = false;
  return new Proxy(target, {
    get(inner, key) {
      if (key === "batch" && !failed) {
        return async () => {
          failed = true;
          throw new Error("D1 に書けない");
        };
      }
      const value = Reflect.get(inner, key) as unknown;
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

describe("決着を残す", () => {
  it("R2 に記録を、D1 に索引を置き、レーティングを動かす", async () => {
    const { accounts, archive, players } = await setup();
    const record = recordOf(pair(players));
    await archive.settle(record);

    expect(objectKey(record)).toBe(`matches/${record.endedAt.slice(0, 10)}/${record.matchId}.json`);
    const stored = await bucket.get(objectKey(record));
    const text = (await stored?.text()) ?? "";
    // JSONL の 1 行と同じ形。取ってきて並べれば、そのまま JSONL になる。
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(record);

    expect((await archive.list(players[0]!)).map((row) => row.matchId)).toEqual([record.matchId]);
    expect(accounts.byPlayerId(players[0]!)?.rating).toBe(INITIAL_RATING + K_FACTOR / 2);
  });

  // 画面は決着のすぐあとに一覧を開き直す。書き終わる前に読むと、指したばかりの対戦が無い。
  it("決着の直後に開いた一覧にも出る", async () => {
    const { archive, players } = await setup();
    const record = recordOf(pair(players));
    void archive.settle(record);

    expect((await archive.list(players[1]!)).map((row) => row.matchId)).toEqual([record.matchId]);
  });

  /**
   * レーティングは対局ログから作り直せる、というのが 7.2 節である。記録に残らなかった対戦で
   * レーティングだけ動かすと、どこから来た差か誰にも言えなくなる。
   */
  it("R2 へ書けなければ、索引もレーティングも動かさない", async () => {
    const { accounts, players } = await setup();
    const broken = new Proxy(bucket, {
      get(inner, key) {
        if (key === "put") return async () => Promise.reject(new Error("R2 に書けない"));
        const value = Reflect.get(inner, key) as unknown;
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
    const archive = new MatchArchive(db, broken, accounts);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await archive.settle(recordOf(pair(players)));
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }

    expect(await archive.list(players[0]!)).toEqual([]);
    expect(accounts.byPlayerId(players[0]!)?.rating).toBe(INITIAL_RATING);
  });
});

describe("一覧と 1 局", () => {
  it("自分が指した対戦だけを返す", async () => {
    const { archive, players } = await setup(3);
    const record = recordOf(pair(players));
    await archive.settle(record);

    expect(await archive.list(players[2]!)).toEqual([]);
    // 他人の対戦と、存在しない対戦を、同じ「無い」にする。
    expect(await archive.find(players[2]!, record.matchId)).toBeNull();
    expect(await archive.find(players[0]!, randomUUID())).toBeNull();
    expect((await archive.find(players[1]!, record.matchId))?.matchId).toBe(record.matchId);
  });

  it("読み手から見た勝ち負けと相手の名前を、新しい順に返す", async () => {
    const { archive, players } = await setup();
    const [a, b] = pair(players);
    const won = recordOf([a, b], { endedAt: "2026-09-01T00:00:00.000Z" });
    const drawn = recordOf([b, a], {
      endedAt: "2026-09-02T00:00:00.000Z",
      matchResult: { kind: "normal", winner: null },
    });
    await archive.settle(won);
    await archive.settle(drawn);

    const rows = await archive.list(a);
    expect(rows.map((row) => row.matchId)).toEqual([drawn.matchId, won.matchId]);
    expect(rows.map((row) => [row.seat, row.outcome, row.opponentName])).toEqual([
      [1, "draw", `名-${b}`],
      [0, "win", `名-${b}`],
    ]);
    expect((await archive.list(b)).map((row) => row.outcome)).toEqual(["draw", "loss"]);
  });

  /**
   * 索引は作り直せる値という建て付けなので、信じきらない。索引の指すオブジェクトが
   * 別の対戦なら、出るのは「読めない」ではなく別の対戦の盤面で、読む人にはそれが分からない。
   */
  it("索引の指す記録が別の対戦なら渡さない", async () => {
    const { archive, players } = await setup();
    const record = recordOf(pair(players));
    await archive.settle(record);
    const other = recordOf(pair(players));
    await bucket.put(objectKey(record), `${JSON.stringify(other)}\n`);

    expect(await archive.find(players[0]!, record.matchId)).toBeNull();
  });

  it("索引にあって R2 に無い対戦は、無いものとして扱う", async () => {
    const { archive, players } = await setup();
    const record = recordOf(pair(players));
    await archive.settle(record);
    await bucket.delete(objectKey(record));

    expect(await archive.find(players[0]!, record.matchId)).toBeNull();
  });
});

describe("R2 と索引の突き合わせ", () => {
  it("R2 に書けて D1 に書けなかった対戦を、次に起きたときに 1 度だけ入れる", async () => {
    const { players } = await setup();
    const failing = batchFailsOnce(db);
    const accounts = new AccountStore(failing);
    const archive = new MatchArchive(failing, bucket, accounts);
    const record = recordOf(pair(players));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await archive.settle(record);
    } finally {
      error.mockRestore();
    }
    // R2 には残っているが、索引にもレーティングにも入っていない。
    expect(await bucket.head(objectKey(record))).not.toBeNull();
    expect(await archive.list(players[0]!)).toEqual([]);
    expect(await ratingOf(players[0]!)).toEqual({ rating: INITIAL_RATING, games: 0 });

    // 起き直した Durable Object の代わり。
    const restarted = await setupOver(db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await restarted.archive.reconcile();
      await restarted.archive.reconcile();
    } finally {
      warn.mockRestore();
    }
    expect((await restarted.archive.list(players[0]!)).map((row) => row.matchId)).toEqual([
      record.matchId,
    ]);
    // 2 度突き合わせても、レーティングに入るのは 1 度だけである。
    expect(await ratingOf(players[0]!)).toEqual({
      rating: INITIAL_RATING + K_FACTOR / 2,
      games: 1,
    });
  });

  /**
   * 突き合わせは Durable Object が起きるたびに走る。済んだ日付より前まで毎回見直すと、
   * 局数に比例して R2 の一覧を引き、D1 の行を読むことになる。
   */
  it("済んだ日付より前は見直さない。覚えた日付が無ければ全部を見る", async () => {
    const { archive, players } = await setup();
    const old = recordOf(pair(players), { endedAt: "2020-01-01T00:00:00.000Z" });
    await bucket.put(objectKey(old), `${JSON.stringify(old)}\n`);
    await setReconciledFrom("2021-01-01");

    await archive.reconcile();
    expect(await archive.list(players[0]!)).toEqual([]);
    // 済んだ日付は、今日から少し戻したところへ進む。
    expect(await reconciledFrom()).toBe(
      new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
    );

    await db.prepare("DELETE FROM archive_state").run();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await archive.reconcile();
    } finally {
      warn.mockRestore();
    }
    expect((await archive.list(players[0]!)).map((row) => row.matchId)).toEqual([old.matchId]);
  });

  /**
   * 突き合わせは一覧を取るあいだ列に並ばないので、その間に決着が同じ対戦を入れうる。
   * 入れ直そうとして失敗に数えると、済んだ日付が進まず、次に起きたときにまた同じ範囲を見る。
   */
  it("一覧を取るあいだに決着が入れた対戦は、入れ直さず失敗にも数えない", async () => {
    const { accounts, players } = await setup();
    const record = recordOf(pair(players));
    await setReconciledFrom(new Date().toISOString().slice(0, 10));
    let settled: () => void = () => {};
    const settleDone = new Promise<void>((resolve) => (settled = resolve));
    // 索引を読んだあと、一覧が返る前に決着が済む形にする。
    const gated = new Proxy(bucket, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key !== "list") return typeof value === "function" ? value.bind(target) : value;
        return async (options: Parameters<R2Bucket["list"]>[0]) => {
          await settleDone;
          return target.list(options);
        };
      },
    });
    const archive = new MatchArchive(db, gated, accounts);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reconciling = archive.reconcile();
      await archive.settle(record);
      settled();
      await reconciling;
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
    expect(await ratingOf(players[0]!)).toEqual({
      rating: INITIAL_RATING + K_FACTOR / 2,
      games: 1,
    });
    expect(await reconciledFrom()).toBe(
      new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
    );
  });

  it("読めないオブジェクトがあっても、ほかの対戦は拾う", async () => {
    const { archive, players } = await setup();
    const day = new Date().toISOString().slice(0, 10);
    await bucket.put(`matches/${day}/${randomUUID()}.json`, "{壊れている");
    const record = recordOf(pair(players));
    await bucket.put(objectKey(record), `${JSON.stringify(record)}\n`);
    await setReconciledFrom(day);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await archive.reconcile();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    expect((await archive.list(players[0]!)).map((row) => row.matchId)).toEqual([record.matchId]);
  });
});

async function setupOver(target: D1Database): Promise<Omit<Setup, "players">> {
  const accounts = new AccountStore(target);
  return { accounts, archive: new MatchArchive(target, bucket, accounts) };
}

async function ratingOf(playerId: string): Promise<{ rating: number; games: number } | null> {
  return db
    .prepare("SELECT rating, games FROM players WHERE player_id = ?")
    .bind(playerId)
    .first<{ rating: number; games: number }>();
}

async function setReconciledFrom(day: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO archive_state (name, value) VALUES ('reconciled-from', ?1)
       ON CONFLICT (name) DO UPDATE SET value = ?1`,
    )
    .bind(day)
    .run();
}

async function reconciledFrom(): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT value FROM archive_state WHERE name = 'reconciled-from'")
    .first<{ value: string }>();
  return row?.value;
}
