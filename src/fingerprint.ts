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
 * 3: `seed` が数値から 16 進 32 桁の文字列になった（6.4 節、9 節）。
 */
export const REPLAY_SCHEMA_VERSION = 3;

/**
 * 再生できる最も古い版。
 *
 * **欄が増えただけでは上げない。** 上げるのは、これより前の記録が、いまのエンジンで
 * **別の対戦を再生してしまう**ときだけである。版 2 までの `seed` は 32 ビットの数値で、
 * 128 ビットになった乱数は同じ値から別の列を出す。再生すれば 0 手目から別のシャッフルに
 * なるが、初期盤面は誤りを出さずに描けてしまう。読む人にそれと分からないので断る。
 */
export const OLDEST_REPLAYABLE_SCHEMA_VERSION = 3;

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
 * コミットが満たすべきなのは、対戦の前にサーバを `seed` へ縛ること（拘束）と、
 * 対戦中は `seed` を何も明かさないこと（秘匿）の 2 つである。接頭辞を分けておけば、
 * この 2 つが `seed` の幅に依存しない。幅が足りずに総当たりで開いたのが 9 節の穴だった。
 */
export interface SeedCommitment {
  nonce: string;
  /**
   * 16 進 32 桁。エンジンの `RngSeed` はこの形で 128 ビットをそのまま受ける。
   * **数値では渡さない。** 数値の種は Float64 を通るので 2^53 通りしか無く、
   * 自分の初手から総当たりで割り出せる（9 節）。
   */
  seed: string;
  commit: string;
}

/** `seed` の桁数。エンジンの `RngState` の幅（128 ビット）に合わせる。 */
const SEED_HEX_DIGITS = 32;

export function commitSeed(nonce: string = randomBytes(32).toString("hex")): SeedCommitment {
  const digest = createHash("sha256").update(`seed:${nonce}`).digest();
  return {
    nonce,
    seed: digest.toString("hex").slice(0, SEED_HEX_DIGITS),
    commit: createHash("sha256").update(`commit:${nonce}`).digest("hex"),
  };
}

/** 公開された `nonce` が、対戦の開始時に配ったコミットと `seed` に一致することを確かめる。 */
export function verifySeedCommitment(commitment: SeedCommitment): boolean {
  const recomputed = commitSeed(commitment.nonce);
  return recomputed.seed === commitment.seed && recomputed.commit === commitment.commit;
}
