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
 * 再生できる最も古い版（6.4 節）。
 *
 * **欄が増えただけでは上げない。** 上げるのは、これより前の記録が、いまのエンジンで
 * **別の対戦を再生してしまう**ときだけである。3 に上げた経緯は 9 節にある。
 *
 * 上げ忘れても `replayability` の種の突き合わせが同じ記録を止める。あちらは導出を
 * やり直すので、判断を挟まない。
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
 * 対戦のあとに、`seed` が対戦の前に決まっていたことを示すための組（6.4 節）。
 *
 * サーバは 256 ビットの `nonce` を引き、そこから**別々の接頭辞で** `seed` とコミットを導く。
 * コミットが満たすべきなのは、対戦の前にサーバを `seed` へ縛ること（拘束）と、
 * 対戦中は `seed` を何も明かさないこと（秘匿）の 2 つである。接頭辞を分けておけば、
 * この 2 つが `seed` の幅に依存しない。
 *
 * `shares` は座席が出したシェアである。サーバが `nonce` を引き直して有利な並びを選べないよう、
 * サーバがコミットしたあとで座席が開いた値を `seed` に混ぜる。
 */
export interface SeedCommitment {
  nonce: string;
  /**
   * 16 進 32 桁。エンジンの `RngSeed` はこの形で 128 ビットをそのまま受ける。
   *
   * **数値では渡さない。** 数値の種は Float64 のビットとして効くので、整数で配れる幅が
   * 2^53 で頭打ちになる。総当たりが現実的になるからではなく（2^53 は 9 節の実測でも
   * 一万年かかる）、幅の上限をここで決めてしまわないためである。足し算で種を組み立てる
   * 側が 2^53 を越えると、隣り合う種が例外も出さずに畳まれる（9 節）。
   */
  seed: string;
  commit: string;
  shares: SeedShares;
}

/** 座席ごとのシェア。出さなかった座席、または期限までに開かなかった座席は null。 */
export type SeedShares = [string | null, string | null];

/** 呼ぶたびに新しい配列を返す。共有すると、1 局のシェアを書き換えたときにほかの対戦まで変わる。 */
export function noShares(): SeedShares {
  return [null, null];
}

/**
 * シェアとそのコミットの形。どちらも 32 バイトの 16 進である。形を決めておかないと、
 * 区切り文字を含むシェアで別の組と同じ入力を作れる。
 */
export const SEED_SHARE_PATTERN = /^[0-9a-f]{64}$/;

/** `seed` の桁数。エンジンの `RngState` の幅（128 ビット）に合わせる。 */
const SEED_HEX_DIGITS = 32;

export function commitSeed(
  nonce: string = randomBytes(32).toString("hex"),
  shares: SeedShares = noShares(),
): SeedCommitment {
  const digest = createHash("sha256").update(seedInput(nonce, shares)).digest();
  return {
    nonce,
    seed: digest.toString("hex").slice(0, SEED_HEX_DIGITS),
    commit: createHash("sha256").update(`commit:${nonce}`).digest("hex"),
    shares,
  };
}

/**
 * シェアが 1 つも無いときは、シェアを混ぜる前と同じ入力にする。そうしておけば、
 * シェアの欄を持たない記録を、読み方を分けずに検算できる。
 */
function seedInput(nonce: string, shares: SeedShares): string {
  if (shares[0] === null && shares[1] === null) return `seed:${nonce}`;
  return `seed:${nonce}:${shares[0] ?? ""}:${shares[1] ?? ""}`;
}

export function commitShare(share: string): string {
  return createHash("sha256").update(`share:${share}`).digest("hex");
}

/** 公開された `nonce` とシェアが、対戦の開始時に配ったコミットと `seed` に一致することを確かめる。 */
export function verifySeedCommitment(commitment: SeedCommitment): boolean {
  const recomputed = commitSeed(commitment.nonce, commitment.shares);
  return recomputed.seed === commitment.seed && recomputed.commit === commitment.commit;
}
