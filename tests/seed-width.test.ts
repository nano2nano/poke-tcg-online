/**
 * 種の幅（`docs/spec/battle-server.md` 9 節）。
 *
 * 塞ぎ方は「128 ビットの種を、切り詰めずにエンジンへ渡す」の 1 点である（9 節）。
 * 切り詰めは例外を出さず、対戦も普通に進む。種の**形**はほかのテストも見ているが、
 * 切り詰めたうえで形を保つ実装（下位 32 ビットを 32 桁へ詰め直すなど）はそれを通るので、
 * 引いた種が本当にシャッフルまで届いているかは、ここでしか見ていない。
 */

import { describe, expect, it } from "vitest";
import { createGame, playerView } from "../src/engine.js";
import { commitSeed } from "../src/fingerprint.js";
import { ensureCards, legalDecks, newMatch } from "./helpers.js";

/** 座席 0 の初手。9 節が「これだけで種が割れた」と言っている観測そのものである。 */
function openingHand(seed: string): string {
  const { state } = createGame({ seed, decks: legalDecks() });
  return playerView(state, 0)
    .self.hand.map((card) => card.instanceId)
    .join(",");
}

describe("種の幅", () => {
  /**
   * 切り詰めは、残す側が上位でも下位でも起こりうるので、両方向を見る。
   * 1 本目は末尾の 1 桁だけが違うので上位を残す実装が、2 本目は 9 桁目だけが違うので
   * 下位 32 ビットを残す実装（歴史的な `seed >>> 0` はこちら）が、同じ列を返して落ちる。
   */
  it("上位 32 ビットが同じで下位だけが違う種は、別のシャッフルになる", () => {
    ensureCards();
    const head = "0000002a";
    expect(openingHand(`${head}${"0".repeat(24)}`)).not.toBe(
      openingHand(`${head}${"0".repeat(23)}1`),
    );
    expect(openingHand(`${head}${"0".repeat(24)}`)).not.toBe(
      openingHand(`${head}1${"0".repeat(23)}`),
    );
  });

  // サーバが 128 ビットを引いても、エンジンへ渡す手前で細くすれば元の穴に戻る。
  it("対戦が使う種は、サーバが引いた 16 進 32 桁そのものである", () => {
    ensureCards();
    const nonce = "seed-width";
    const match = newMatch(nonce);
    expect(match.seedCommitment.seed).toMatch(/^[0-9a-f]{32}$/);
    expect(
      playerView(match.state, 0)
        .self.hand.map((card) => card.instanceId)
        .join(","),
    ).toBe(openingHand(commitSeed(nonce).seed));
  });
});
