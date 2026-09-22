/**
 * エンジンの指紋（`docs/spec/battle-server.md` 6.3 節）。
 *
 * 指紋が「取れなかった」に落ちても、対戦は普通に動いてしまう。落ちたことに気づけるのは
 * ここだけなので、値が本当に埋まっていることをテストで押さえる。
 */

import { describe, expect, it } from "vitest";
import { commitSeed, engineFingerprint, verifySeedCommitment } from "../src/fingerprint.js";

describe("エンジンの指紋", () => {
  // 取り込み方を変えたときにパスが外れると "unknown" へ落ち、再生の拒否が黙って無効になる。
  it("カードデータのハッシュが埋まっている", () => {
    const fingerprint = engineFingerprint();
    expect(fingerprint.cardDataSha256).not.toBe("unknown");
    expect(fingerprint.cardDataSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("再生の解釈を選ぶための版番号を持つ", () => {
    expect(engineFingerprint().replaySchemaVersion).toBeGreaterThanOrEqual(2);
  });
});

describe("シャッフルのコミット", () => {
  it("同じ nonce からは同じ seed とコミットが出る", () => {
    const first = commitSeed("なんらかの nonce");
    expect(commitSeed("なんらかの nonce")).toEqual(first);
    expect(verifySeedCommitment(first)).toBe(true);
  });

  // 接頭辞を分けないと、コミットが seed そのものの導出になる。
  it("コミットから seed が導けないよう、別々の接頭辞で導く", () => {
    const commitment = commitSeed("べつの nonce");
    expect(commitment.commit).not.toContain(commitment.seed);
    // 1 桁足すだけにする。特定の文字へ置き換えると、元がその文字だった seed で改変にならない。
    expect(verifySeedCommitment({ ...commitment, seed: `${commitment.seed}0` })).toBe(false);
  });

  // 数値で持つと、整数で配れる幅が 2^53 で頭打ちになる（仕様 9 節）。
  it("seed は 16 進 32 桁の文字列である", () => {
    expect(commitSeed("さらにべつの nonce").seed).toMatch(/^[0-9a-f]{32}$/);
  });
});
