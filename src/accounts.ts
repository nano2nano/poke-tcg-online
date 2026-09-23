/**
 * プレイヤーとレーティング（`docs/spec/battle-server.md` 7.2 節）。
 *
 * 持つ理由は対戦の体験ではなく記録である。座席と人をあとから結び直すことはできないので、
 * 対戦の時点で持っていなければ、その対戦には二度と付けられない。
 *
 * 置くのは識別子・表示名・レーティングだけで、人を特定できる値は持たない。
 * シークレットは控えを取らず、照合はハッシュで行う。理由は 7.2 節にある。
 */

import { createHash, randomBytes } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types/index.ts";

/** アカウントが見つからないことを、画面の文言に頼らずに伝える合図。 */
export const ACCOUNT_NOT_FOUND = "account-not-found";

/** 最初のレーティング。 */
export const INITIAL_RATING = 1500;

/** 1 局で動く幅を決める係数。局数が少ないうちに動きすぎない程度に取る。 */
export const K_FACTOR = 24;

export interface Account {
  /** 公開の識別子。対局ログに残るのはこちらである。 */
  playerId: string;
  displayName: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  createdAt: string;
  lastSeenAt: string;
}

/** 表示名の上限。表示名であって本人確認ではないので、長さだけ見る。 */
const MAX_DISPLAY_NAME = 40;

/**
 * メモリに置いておくプレイヤーの数。ロビーは同期で動くので、待っている人と対戦中の人は
 * ここから引く（`src/lobby.ts`）。溢れたら長く使われていないものから捨て、次は D1 から読み直す。
 */
const CACHED_ACCOUNTS = 4_096;

interface StoredAccount extends Account {
  /** シークレットそのものは持たない。漏れても入れないようにする。 */
  secretHash: string;
}

interface PlayerRow {
  player_id: string;
  secret_hash: string;
  display_name: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  created_at: string;
  last_seen_at: string;
}

/**
 * D1 の `players` を読み書きする。
 *
 * **書き換えるのはこの Durable Object だけである。** だからメモリに持っている版が常に最新で、
 * D1 から読むのはメモリに無いときだけにする。
 *
 * **D1 への読み書きは 1 本の列に並べる。** 読み直しが、先に出した書き込みを追い越さないためである。
 * 追い越すと、捨てたあとに読み直した版が古く、たとえば 1 局前のレーティングで次の対戦が始まる。
 */
export class AccountStore {
  /** 識別子 → プレイヤー。`Map` は入れた順に並ぶので、使ったものを後ろへ回すと先頭が最も古い。 */
  private readonly cached = new Map<string, StoredAccount>();
  /** シークレットのハッシュ → 識別子。 */
  private readonly bySecretHash = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: D1Database,
    private readonly capacity: number = CACHED_ACCOUNTS,
  ) {}

  /**
   * 新しいプレイヤーを作る。シークレットを返すのはこのときだけで、控えは持たない。
   *
   * **書けてから覚える。** シークレットを返すのはこのときだけなので、書けなかったのに
   * メモリにだけ残ると、D1 に無いプレイヤーで対戦が始まり、その戦績はどこにも残らない。
   */
  async create(displayName: string, nowMs: number): Promise<{ account: Account; secret: string }> {
    const secret = randomBytes(24).toString("base64url");
    const at = new Date(nowMs).toISOString();
    const stored: StoredAccount = {
      playerId: randomBytes(12).toString("base64url"),
      displayName: cleanName(displayName),
      rating: INITIAL_RATING,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      createdAt: at,
      lastSeenAt: at,
      secretHash: hash(secret),
    };
    await this.enqueue(() =>
      this.db
        .prepare(
          `INSERT INTO players (player_id, secret_hash, display_name, rating, games, wins, losses,
             draws, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          stored.playerId,
          stored.secretHash,
          stored.displayName,
          stored.rating,
          stored.games,
          stored.wins,
          stored.losses,
          stored.draws,
          stored.createdAt,
          stored.lastSeenAt,
        )
        .run(),
    );
    this.remember(stored);
    return { account: publicOf(stored), secret };
  }

  /** シークレットからプレイヤーを引く。メモリに無ければ D1 から読む。 */
  async find(secret: string): Promise<Account | null> {
    const secretHash = hash(secret);
    const playerId = this.bySecretHash.get(secretHash);
    const stored =
      playerId === undefined
        ? await this.load("secret_hash", secretHash)
        : await this.loadById(playerId);
    return stored === null ? null : publicOf(stored);
  }

  /** メモリにあるときだけ返す。ロビーは同期で動くので、読み込みは呼び手が先に済ませておく。 */
  byPlayerId(playerId: string): Account | null {
    const stored = this.cached.get(playerId);
    return stored === undefined ? null : publicOf(stored);
  }

  /** 表示名を変える。レーティングと戦績は動かない。 */
  rename(account: Account, displayName: string, nowMs: number): Account {
    const name = cleanName(displayName);
    const at = new Date(nowMs).toISOString();
    this.update(account.playerId, "display_name = ?, last_seen_at = ?", [name, at], (stored) => {
      stored.displayName = name;
      stored.lastSeenAt = at;
    });
    return { ...account, displayName: name, lastSeenAt: at };
  }

  touch(account: Account, nowMs: number): Account {
    const at = new Date(nowMs).toISOString();
    this.update(account.playerId, "last_seen_at = ?", [at], (stored) => {
      stored.lastSeenAt = at;
    });
    return { ...account, lastSeenAt: at };
  }

  /**
   * 1 局の結果をレーティングへ入れる。`score` は座席 0 から見た値で、勝ち 1・引き分け 0.5・負け 0。
   *
   * `alongside` は同じトランザクションで書く文である。対局ログの索引の行をここへ渡すと、
   * 「索引に行がある」と「レーティングに入った」が必ずそろう（`src/archive.ts`）。
   * 書けなければ投げる。プレイヤーが D1 に無ければ、`alongside` だけを書いて null を返す。
   *
   * 投了と時間切れも普通の負けとして数える。規則上の敗北条件ではない（§2.3）が、
   * それは対局ログの `matchResult` が区別して持っている。レーティングは勝敗の履歴であって、
   * 学習の終端報酬ではない。
   */
  async applyResult(
    playerIds: [string, string],
    score: number,
    nowMs: number,
    alongside: D1PreparedStatement[] = [],
  ): Promise<[number, number] | null> {
    const [a, b] = await Promise.all(playerIds.map((playerId) => this.loadById(playerId)));
    if (a == null || b == null) {
      await this.enqueue(() => (alongside.length === 0 ? null : this.db.batch(alongside)));
      return null;
    }
    const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const ratings: [number, number] = [
      Math.round(a.rating + K_FACTOR * (score - expectedA)),
      Math.round(b.rating + K_FACTOR * (1 - score - (1 - expectedA))),
    ];
    const at = new Date(nowMs).toISOString();
    const outcomes = [score, 1 - score].map((own) => ({
      wins: own === 1 ? 1 : 0,
      losses: own === 0 ? 1 : 0,
      draws: own !== 1 && own !== 0 ? 1 : 0,
    }));
    try {
      await this.enqueue(() =>
        this.db.batch([
          ...alongside,
          ...[a, b].map((stored, seat) =>
            this.db
              .prepare(
                `UPDATE players SET rating = ?, games = games + 1, wins = wins + ?,
                 losses = losses + ?, draws = draws + ?, last_seen_at = ? WHERE player_id = ?`,
              )
              .bind(
                ratings[seat],
                outcomes[seat]!.wins,
                outcomes[seat]!.losses,
                outcomes[seat]!.draws,
                at,
                stored.playerId,
              ),
          ),
        ]),
      );
    } catch (error) {
      /**
       * **書けたかどうかは分からない。** 通ってから応答だけが落ちることもある。レーティングは
       * メモリの値から計算した値をそのまま書くので、古い値を残すと次の対戦で D1 の値を巻き戻す。
       * メモリから捨てて、次は D1 から読み直す。
       */
      this.forget(a);
      this.forget(b);
      throw error;
    }
    for (const [seat, stored] of [a, b].entries()) {
      stored.rating = ratings[seat]!;
      stored.games += 1;
      stored.wins += outcomes[seat]!.wins;
      stored.losses += outcomes[seat]!.losses;
      stored.draws += outcomes[seat]!.draws;
      stored.lastSeenAt = at;
    }
    return ratings;
  }

  /** 出した書き込みが全部済むまで待つ。 */
  async settled(): Promise<void> {
    await this.queue;
  }

  private async loadById(playerId: string): Promise<StoredAccount | null> {
    const stored = this.cached.get(playerId);
    if (stored !== undefined) {
      this.cached.delete(playerId);
      this.cached.set(playerId, stored);
      return stored;
    }
    return this.load("player_id", playerId);
  }

  private async load(
    column: "player_id" | "secret_hash",
    value: string,
  ): Promise<StoredAccount | null> {
    const row = await this.enqueue(() =>
      this.db.prepare(`SELECT * FROM players WHERE ${column} = ?`).bind(value).first<PlayerRow>(),
    );
    if (row === null) return null;
    // 読んでいる間に、同じプレイヤーを別の要求が覚えていれば、メモリのほうが新しい。
    return this.cached.get(row.player_id) ?? this.remember(fromRow(row));
  }

  /**
   * メモリにあれば書き換え、D1 へは列に並べて書く。**メモリに無くても D1 へは書く。**
   * 次に読み直すときは同じ列の後ろに並ぶので、この書き込みを追い越さない。
   */
  private update(
    playerId: string,
    assignments: string,
    values: string[],
    change: (stored: StoredAccount) => void,
  ): void {
    const stored = this.cached.get(playerId);
    if (stored !== undefined) change(stored);
    this.enqueue(() =>
      this.db
        .prepare(`UPDATE players SET ${assignments} WHERE player_id = ?`)
        .bind(...values, playerId)
        .run(),
    ).catch((error: unknown) => {
      console.error(`プレイヤーを書けなかった（${playerId}）:`, error);
    });
  }

  private remember(stored: StoredAccount): StoredAccount {
    this.cached.delete(stored.playerId);
    this.cached.set(stored.playerId, stored);
    this.bySecretHash.set(stored.secretHash, stored.playerId);
    for (const oldest of this.cached.values()) {
      if (this.cached.size <= this.capacity) break;
      this.forget(oldest);
    }
    return stored;
  }

  private forget(stored: StoredAccount): void {
    this.cached.delete(stored.playerId);
    this.bySecretHash.delete(stored.secretHash);
  }

  /** 前の書き込みが落ちても、列そのものは止めない。落ちた要求の呼び手にだけ投げる。 */
  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function fromRow(row: PlayerRow): StoredAccount {
  return {
    playerId: row.player_id,
    displayName: row.display_name,
    rating: row.rating,
    games: row.games,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    secretHash: row.secret_hash,
  };
}

function publicOf(stored: StoredAccount): Account {
  const { secretHash: _secretHash, ...account } = stored;
  return { ...account };
}

function hash(secret: string): string {
  return createHash("sha256").update(`account:${secret}`).digest("hex");
}

/**
 * 見えない字。制御文字（Cc）と書式文字（Cf）の両方を落とす。
 *
 * **0x20 より下だけでは足りない。** DEL と 0x80〜0x9f は Cc、向きを変える U+202E や
 * 幅の無い U+FEFF は Cf にあり、どちらも数値では下に来ない。U+202E が名前に入ると、
 * 一覧に並んだ相手の名前がうしろから読める形で出る。
 *
 * 相方を失った片割れ（Cs）も同じ扱いにする。それだけでは字にならず、書き出すときに
 * 別の値へ化けるので、ストアにも対局ログにも入れない。
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}]/u;

/**
 * 見えないが、字を繋ぐために要るもの。
 *
 * ZWJ は絵文字を 1 文字に繋ぎ、ZWNJ はデーヴァナーガリーやペルシア文字で
 * 繋がりを断つ。**落とすと、その人の名前が別の字になる。** 向きは変えないので残す。
 */
const JOINERS = new Set(["\u200c", "\u200d"]);

function cleanName(displayName: string): string {
  // 見えない字を落とすのは、表示名が画面と対局ログの両方へ出るためである。
  // **切るのは文字の単位である。** UTF-16 の長さで切ると、絵文字が半分になったものが
  // そのままストアにも対局ログにも入る。
  const cleaned = [...displayName.trim()]
    .filter((char) => JOINERS.has(char) || !INVISIBLE.test(char))
    .slice(0, MAX_DISPLAY_NAME)
    .join("")
    // 繋ぐ相手を失った端の繋ぎ字は、それだけでは字にならない。
    .replace(/^[\u200c\u200d]+|[\u200c\u200d]+$/gu, "")
    .trim();
  return cleaned === "" ? "ななし" : cleaned;
}
