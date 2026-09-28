/**
 * 着いている座席の覚え方と、決着のあとのシャッフルの検算。
 */

import type { SeedShares } from "../../src/fingerprint.js";
import type { Seated } from "../../src/lobby.js";
import type { EndedMessage } from "../../src/protocol.js";
import { BASEPATH } from "../basepath.js";

/**
 * 画面が覚える座席。繋ぎ直しに要るのは座席トークンと番号だけで、残りは検算に使う。
 * 入り直した画面や古い記録では、残りが欠けていることがある。
 */
export type StoredSeat = Pick<Seated, "seat" | "seatToken"> &
  Partial<Pick<Seated, "matchId" | "seedCommit" | "seedShareCommits">> & {
    /** 自分のシェア。席に着いたら開く値で、繋ぎ直しでも付ける。 */
    seedShare?: string;
  };

/**
 * 指している座席を置く localStorage のキー。いまの画面と同じキーにして、入れ替えのあとも同じ座席へ繋ぎ直せるようにする。
 *
 * **持たずに閉じると、その対戦には二度と入れない。** 繋ぎ直しに要るのは座席トークンだけ
 * （3.3 節）で、切断中も時計は流れる（3.4 節）ので、戻れないまま時間切れで負ける。
 */
const SEAT_KEY = "poke-seat";

export function rememberSeat(seated: StoredSeat): void {
  localStorage.setItem(SEAT_KEY, JSON.stringify(seated));
}

/** 覚えている座席がこの座席のときだけ忘れる。別のタブが新しい対戦の座席を置いていれば、それは消さない。 */
export function forgetSeat(seatToken: string): void {
  if (storedSeat()?.seatToken === seatToken) localStorage.removeItem(SEAT_KEY);
}

/** 覚えている座席。読めない値が入っていたら捨てる。 */
export function storedSeat(): StoredSeat | null {
  const raw = localStorage.getItem(SEAT_KEY);
  if (raw === null) return null;
  let seated: unknown = null;
  try {
    seated = JSON.parse(raw);
  } catch {
    localStorage.removeItem(SEAT_KEY);
    return null;
  }
  // 座席トークンが無ければ繋ぎようがない。座席の番号は時計と手札の向きに使う。
  const { seatToken, seat } = (seated ?? {}) as Partial<StoredSeat>;
  if (typeof seatToken !== "string" || (seat !== 0 && seat !== 1)) {
    localStorage.removeItem(SEAT_KEY);
    return null;
  }
  return seated as StoredSeat;
}

/** 観戦のリンク。渡された人は、この画面と同じ場所で観戦の卓を開く。 */
export function watchUrl(spectatorToken: string): string {
  return `${location.origin}${BASEPATH}/?watch=${encodeURIComponent(spectatorToken)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ShuffleCheck =
  | "ok"
  | "opponent-share-unused"
  | "share-unused"
  | "mismatch"
  | "unavailable"
  | "error";

/**
 * 決着のあとに開かれた値を、席に着く前に受け取ったコミットと突き合わせる（仕様 6.4 節）。
 * 比べる相手はサーバが今送ってきた値ではなく、シェアを開く前に覚えた値である。
 * サーバの言い分同士を比べても、あとから選び直した並びは見分けられない。
 */
export async function checkShuffle(
  seated: StoredSeat,
  ended: Pick<EndedMessage, "seed" | "seedNonce" | "seedShares">,
): Promise<[ShuffleCheck, string]> {
  try {
    return await verifyShuffle(seated, ended);
  } catch {
    return ["error", "シャッフルを検算できませんでした。"];
  }
}

async function verifyShuffle(
  seated: StoredSeat,
  ended: Pick<EndedMessage, "seed" | "seedNonce" | "seedShares">,
): Promise<[ShuffleCheck, string]> {
  const { seedCommit, seedShareCommits: commits } = seated;
  if (typeof seedCommit !== "string" || !Array.isArray(commits)) {
    return ["unavailable", "この対戦の開始時の値を覚えていないので、シャッフルを検算できません。"];
  }
  if (globalThis.crypto?.subtle === undefined) {
    return ["unavailable", "この接続（https でない）では、シャッフルを検算できません。"];
  }
  const shares: SeedShares = ended.seedShares;
  const problems: string[] = [];
  // 座席の割り当てに載ってきた自分のコミットが、送ったものと同じか。すり替えられていれば、
  // サーバが選んだ値を自分のシェアとして開いても、下の突き合わせは全部通ってしまう。
  if (
    typeof seated.seedShare === "string" &&
    commits[seated.seat] !== (await sha256Hex(`share:${seated.seedShare}`))
  ) {
    problems.push("自分のシェアのコミットがすり替えられています");
  }
  if ((await sha256Hex(`commit:${ended.seedNonce}`)) !== seedCommit) {
    problems.push("サーバのコミットと合いません");
  }
  for (const side of [0, 1] as const) {
    const share = shares[side];
    if (share === null) continue;
    const commit = commits[side];
    if (commit === null || (await sha256Hex(`share:${share}`)) !== commit) {
      problems.push(`${side === seated.seat ? "自分" : "相手"}のシェアがコミットと合いません`);
    }
  }
  const input =
    shares[0] === null && shares[1] === null
      ? `seed:${ended.seedNonce}`
      : `seed:${ended.seedNonce}:${shares[0] ?? ""}:${shares[1] ?? ""}`;
  if ((await sha256Hex(input)).slice(0, 32) !== ended.seed) {
    problems.push("seed が開かれた値から導けません");
  }
  if (problems.length > 0) {
    return ["mismatch", `シャッフルの検算が合いません: ${problems.join("、")}`];
  }
  // シェアを覚えていない画面（入り直した画面など）でも、コミットしたシェアが開かれなかったことは分かる。
  if (
    (typeof seated.seedShare === "string" && shares[seated.seat] !== seated.seedShare) ||
    (shares[seated.seat] === null && commits[seated.seat] !== null)
  ) {
    return [
      "share-unused",
      "シャッフルに自分のシェアが使われていません。席に着くのが期限に間に合わなかったか、サーバがシェアを捨てています。",
    ];
  }
  // 期限に遅れたことにしてシェアを捨てれば、サーバは並びを 2 通りから選べる。黙って「合う」とだけ出さない。
  const opponent = seated.seat === 0 ? 1 : 0;
  if (shares[opponent] === null && commits[opponent] !== null) {
    return [
      "opponent-share-unused",
      "シャッフルの値を検算しました。ただし相手のシェアは期限までに開かれず、並びはサーバと自分の値で決まりました。",
    ];
  }
  // 確かめたのは値の対応までである。その seed で対局したかは、記録を再生しないと分からない。
  return ["ok", "シャッフルの値を検算しました。seed は、対戦の前にコミットされた値から導けます。"];
}
