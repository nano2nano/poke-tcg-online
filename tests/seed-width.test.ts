/**
 * 種の幅（`docs/spec/battle-server.md` 9 節）。
 *
 * 塞ぐ前は、対戦中の人が自分の初手だけから種を総当たりで割り出せた。塞ぎ方は
 * 「128 ビットの種を、切り詰めずにエンジンへ渡す」の 1 点である。切り詰めは例外を出さず、
 * 対戦も普通に進むので、戻ったことに気づけるのはここだけになる。
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
  // 上位 32 ビットを揃えてあるので、切り詰める実装では 2 つが同じ列になる。
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
