import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkShuffle, forgetSeat, rememberSeat, storedSeat, type StoredSeat } from "./seat.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** サーバが開く値と、席に着く前に配ったコミットを、同じ手順で作る。 */
function opened(shares: [string, string]) {
  const seedNonce = "開いた値";
  const seated: StoredSeat = {
    seat: 0,
    seatToken: "座席",
    seedShare: shares[0],
    seedCommit: sha(`commit:${seedNonce}`),
    seedShareCommits: [sha(`share:${shares[0]}`), sha(`share:${shares[1]}`)],
  };
  const ended = {
    seedNonce,
    seedShares: shares,
    seed: sha(`seed:${seedNonce}:${shares[0]}:${shares[1]}`).slice(0, 32),
  };
  return { seated, ended };
}

describe("checkShuffle", () => {
  it("開かれた値がコミットと合えば ok", async () => {
    const { seated, ended } = opened(["自分", "相手"]);
    expect((await checkShuffle(seated, ended))[0]).toBe("ok");
  });

  it("相手のシェアが差し替えられていたら合わない", async () => {
    const { seated, ended } = opened(["自分", "相手"]);
    // seed も差し替えた値から導き直す。合わないのは、相手のシェアとそのコミットだけになる。
    const seed = sha(`seed:${ended.seedNonce}:自分:別の値`).slice(0, 32);
    const swapped = { ...ended, seed, seedShares: ["自分", "別の値"] as [string, string] };
    expect((await checkShuffle(seated, swapped))[0]).toBe("mismatch");
  });

  it("自分のシェアのコミットがすり替えられていたら合わない", async () => {
    const { seated, ended } = opened(["自分", "相手"]);
    const forged = { ...seated, seedShare: "送ったつもりの値" };
    expect((await checkShuffle(forged, ended))[0]).toBe("mismatch");
  });

  it("相手のシェアが開かれなければ、そう分ける", async () => {
    const { seated, ended } = opened(["自分", "相手"]);
    const seed = sha(`seed:${ended.seedNonce}:自分:`).slice(0, 32);
    const late = { ...ended, seed, seedShares: ["自分", null] as [string, null] };
    expect((await checkShuffle(seated, late))[0]).toBe("opponent-share-unused");
  });

  it("開始時の値を覚えていなければ検算しない", async () => {
    const { ended } = opened(["自分", "相手"]);
    expect((await checkShuffle({ seat: 0, seatToken: "座席" }, ended))[0]).toBe("unavailable");
  });
});

describe("forgetSeat", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("覚えている座席がこの座席なら忘れる", () => {
    rememberSeat({ seat: 0, seatToken: "終わった対戦" });
    forgetSeat("終わった対戦");
    expect(storedSeat()).toBeNull();
  });

  it("別のタブが置いた新しい座席は残す", () => {
    rememberSeat({ seat: 1, seatToken: "新しい対戦" });
    forgetSeat("終わった対戦");
    expect(storedSeat()?.seatToken).toBe("新しい対戦");
  });
});
