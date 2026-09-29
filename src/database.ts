/**
 * D1 の表（`docs/spec/battle-server.md` 5.5 節、6.5 節、7.2 節）。
 *
 * プレイヤーと、プレイヤーが保存したデッキと、対局ログの索引を置く。対局ログそのものは R2 にある（`src/archive.ts`）。
 *
 * 表を作るのは Durable Object が起きたときである。`wrangler d1 migrations` にしないのは、
 * 出す手順を `wrangler deploy` 1 つに保つためである。
 */

import type { D1Database } from "@cloudflare/workers-types/index.ts";

/**
 * 表の形を変えるときは、末尾に 1 段足す。**すでにある段は書き換えない。**
 * どこまで当てたかは `schema_version` が覚えていて、起きるたびに残りだけを当てる。
 */
const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE players (
      player_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      games INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      draws INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )`,
    // 行を足すのとレーティングを動かすのは、1 つのトランザクションで行う（6.5 節）。
    `CREATE TABLE matches (
      match_id TEXT PRIMARY KEY,
      object_key TEXT NOT NULL,
      ended_day TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      seat0_player TEXT NOT NULL,
      seat1_player TEXT NOT NULL,
      seat0_name TEXT NOT NULL,
      seat1_name TEXT NOT NULL,
      match_result TEXT NOT NULL,
      move_count INTEGER NOT NULL
    )`,
    "CREATE INDEX matches_by_seat0 ON matches (seat0_player, ended_at DESC)",
    "CREATE INDEX matches_by_seat1 ON matches (seat1_player, ended_at DESC)",
    "CREATE INDEX matches_by_day ON matches (ended_day)",
    "CREATE TABLE archive_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ],
  [
    // `cards` は `[{ defId, count }]` の JSON。中身で探すことが無いので、行に分けない。
    `CREATE TABLE decks (
      deck_id TEXT PRIMARY KEY,
      player_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cards TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    "CREATE INDEX decks_by_player ON decks (player_id, updated_at DESC)",
  ],
];

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = await db
    .prepare("SELECT MAX(version) AS version FROM schema_version")
    .first<{ version: number | null }>();
  const applied = row?.version ?? 0;
  for (const [index, statements] of MIGRATIONS.entries()) {
    const version = index + 1;
    if (version <= applied) continue;
    // 1 段は 1 つのトランザクションにする。途中で落ちると、表の半分だけある形で次に起きることになる。
    await db.batch([
      ...statements.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").bind(version),
    ]);
  }
}
