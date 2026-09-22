/**
 * エンジンの同一性（`docs/spec/battle-server.md` 6.3 節）と、シャッフルの公正さの
 * コミット（同 6.4 節）。
 *
 * エンジンを直すと、同じ move 列が別の対戦を再生しうる。エンジンの指紋が無いログは、
 * 再生できるかどうかを言えない（1 節の S-6）。
 */

import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ログのレコードの形の版。読み手はこれを見て解釈を選ぶ。
 *
 * 2: 1 手ごとに `candidates` / `chosen` / `offered` を持つ（6.2 節）。
 * 3: `seed` が 32 桁の 16 進文字列。2 までは 32 ビットの数値だった。
 */
export const REPLAY_SCHEMA_VERSION = 3;

export interface EngineFingerprint {
  /** エンジンの submodule が指す commit。取れなければ "unknown"。 */
  commit: string;
  /** 正規カードデータの内容ハッシュ。これの不一致は再生を拒否する理由になる。 */
  cardDataSha256: string;
  replaySchemaVersion: number;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let cached: EngineFingerprint | null = null;

export function engineFingerprint(): EngineFingerprint {
  if (cached !== null) return cached;
  cached = {
    commit: engineCommit(),
    cardDataSha256: cardDataSha256(),
    replaySchemaVersion: REPLAY_SCHEMA_VERSION,
  };
  return cached;
}

/**
 * submodule が指す commit。環境変数を先に見るのは、本番では submodule ごと固めた
 * 成果物を置き、`.git` が無い形で動かすことがあるためである。
 */
function engineCommit(): string {
  const fromEnv = process.env.POKE_ENGINE_COMMIT;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    return execFileSync("git", ["-C", join(ROOT, "engine"), "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function cardDataSha256(): string {
  const path = join(ROOT, "engine", "data", "cards.generated.json");
  if (!existsSync(path)) return "unknown";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * シャッフルの公正さを事後に示すための組（6.4 節）。
 *
 * 256 ビットの `nonce` を引き、そこから**別々の接頭辞で** `seed` とコミットを導く。
 * 接頭辞を分けないとコミットから `seed` が出てしまう。
 */
export interface SeedCommitment {
  nonce: string;
  /**
   * 32 桁の 16 進。エンジンの `RngState` の幅と同じ 128 ビットを渡す。
   *
   * **幅を削らない。** ここが 32 ビットだった頃は、自分の初手 7 枚だけから
   * 総当たりで seed が一意に決まり、自分の山札とサイド、相手のデッキリストを
   * 知っていれば相手の山札とサイドまで読めた（エンジンの `RngState` の docblock）。
   */
  seed: string;
  commit: string;
}

const SEED_BYTES = 16;

export function commitSeed(nonce: string = randomBytes(32).toString("hex")): SeedCommitment {
  const digest = createHash("sha256").update(`seed:${nonce}`).digest();
  return {
    nonce,
    seed: digest.subarray(0, SEED_BYTES).toString("hex"),
    commit: createHash("sha256").update(`commit:${nonce}`).digest("hex"),
  };
}

/** 公開された `nonce` が、対戦の開始時に配ったコミットと `seed` に一致することを確かめる。 */
export function verifySeedCommitment(commitment: SeedCommitment): boolean {
  const recomputed = commitSeed(commitment.nonce);
  return recomputed.seed === commitment.seed && recomputed.commit === commitment.commit;
}
