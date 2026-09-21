/**
 * 打ち手と持ち点（`docs/spec/battle-server.md` 7.2 節）。
 *
 * **持つ理由は対戦の体験ではなく、記録である。** 人の手を真似て学ぶとき、打った人の強さは
 * 最も効く共変量になる。そして座席と人をあとから結び直すことはできないので、
 * 対戦の時点で持っていなければ、その対戦には二度と付けられない。
 *
 * **人を特定できる値を持たない。** 置くのはサーバが発行した識別子と、本人が名乗った
 * 表示名と、持ち点だけである。合言葉は控えを取らず、照合はハッシュで行う。
 * 学習に要るのは「同じ人か」と「どのくらい強いか」の 2 つだけで、それ以上は要らない。
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 最初の持ち点。 */
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

/** 表示名の上限。名乗りであって本人確認ではないので、長さだけ見る。 */
const MAX_DISPLAY_NAME = 40;

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

interface StoredAccount extends Account {
  /** 合言葉そのものは持たない。漏れても入れないようにする。 */
  secretHash: string;
}

export class AccountStore {
  private readonly accounts = new Map<string, StoredAccount>();
  /** 合言葉のハッシュ → 識別子。 */
  private readonly bySecretHash = new Map<string, string>();

  constructor(private readonly dir: string = DEFAULT_DIR) {
    this.load();
  }

  /** 新しい打ち手を作る。合言葉を返すのはこのときだけで、控えは持たない。 */
  create(displayName: string, nowMs: number): { account: Account; secret: string } {
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
    this.accounts.set(stored.playerId, stored);
    this.bySecretHash.set(stored.secretHash, stored.playerId);
    this.save();
    return { account: publicOf(stored), secret };
  }

  bySecret(secret: string): Account | null {
    const playerId = this.bySecretHash.get(hash(secret));
    if (playerId === undefined) return null;
    const stored = this.accounts.get(playerId);
    return stored === undefined ? null : publicOf(stored);
  }

  byPlayerId(playerId: string): Account | null {
    const stored = this.accounts.get(playerId);
    return stored === undefined ? null : publicOf(stored);
  }

  /** 名乗り直す。持ち点と戦績は動かない。 */
  rename(secret: string, displayName: string, nowMs: number): Account | null {
    const stored = this.storedBySecret(secret);
    if (stored === null) return null;
    stored.displayName = cleanName(displayName);
    stored.lastSeenAt = new Date(nowMs).toISOString();
    this.save();
    return publicOf(stored);
  }

  touch(secret: string, nowMs: number): Account | null {
    const stored = this.storedBySecret(secret);
    if (stored === null) return null;
    stored.lastSeenAt = new Date(nowMs).toISOString();
    this.save();
    return publicOf(stored);
  }

  /**
   * 1 局の結果を持ち点へ入れる。`score` は座席 0 から見た値で、勝ち 1・引き分け 0.5・負け 0。
   *
   * 投了と時間切れも普通の負けとして数える。規則上の敗北条件ではない（§2.3）が、
   * それは対局ログの `matchResult` が区別して持っている。持ち点は勝敗の履歴であって、
   * 学習の終端報酬ではない。
   */
  applyResult(playerIds: [string, string], score: number, nowMs: number): [number, number] | null {
    const a = this.accounts.get(playerIds[0]);
    const b = this.accounts.get(playerIds[1]);
    if (a === undefined || b === undefined) return null;

    const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    a.rating = Math.round(a.rating + K_FACTOR * (score - expectedA));
    b.rating = Math.round(b.rating + K_FACTOR * (1 - score - (1 - expectedA)));

    const at = new Date(nowMs).toISOString();
    for (const [account, own] of [
      [a, score],
      [b, 1 - score],
    ] as const) {
      account.games += 1;
      if (own === 1) account.wins += 1;
      else if (own === 0) account.losses += 1;
      else account.draws += 1;
      account.lastSeenAt = at;
    }
    this.save();
    return [a.rating, b.rating];
  }

  count(): number {
    return this.accounts.size;
  }

  private storedBySecret(secret: string): StoredAccount | null {
    const playerId = this.bySecretHash.get(hash(secret));
    if (playerId === undefined) return null;
    return this.accounts.get(playerId) ?? null;
  }

  private get path(): string {
    return join(this.dir, "accounts.json");
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const rows = JSON.parse(readFileSync(this.path, "utf8")) as StoredAccount[];
    for (const row of rows) {
      this.accounts.set(row.playerId, row);
      this.bySecretHash.set(row.secretHash, row.playerId);
    }
  }

  /**
   * 書き換えは別名で書いてから差し替える。途中で落ちても、読める古い版が残る。
   * データベースを置かないのは対局ログと同じ理由で、索引が要る問い合わせが無いからである。
   */
  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.path}.writing`;
    writeFileSync(temporary, `${JSON.stringify([...this.accounts.values()], null, 2)}\n`, "utf8");
    renameSync(temporary, this.path);
  }
}

function publicOf(stored: StoredAccount): Account {
  const { secretHash: _secretHash, ...account } = stored;
  return { ...account };
}

function hash(secret: string): string {
  return createHash("sha256").update(`account:${secret}`).digest("hex");
}

function cleanName(displayName: string): string {
  // 制御文字を落とすのは、表示名が画面と対局ログの両方へ出るためである。
  const cleaned = [...displayName.trim()]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 0x20)
    .join("")
    .slice(0, MAX_DISPLAY_NAME);
  return cleaned === "" ? "ななし" : cleaned;
}
