/**
 * 記録された手が、いまのエンジンで指せなくなったときの止まりかた（6.6 節）。
 *
 * 合法手の照合で止まる道は通常の再生で確かめられるが、**照合を通ったのに
 * `applyMove` が投げる道**は、エンジンの食い違いでしか起きないので作れない。
 * ここだけ `applyMove` を差し替えて、その道でも止まりかたが同じことを見る。
 */

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concede } from "../src/match.js";
import { toRecord } from "../src/log.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

const control = vi.hoisted(() => ({ throwAt: null as number | null, seen: 0, calls: 0 }));

vi.mock("../src/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine.js")>();
  return {
    ...actual,
    applyMove: (...args: Parameters<typeof actual.applyMove>) => {
      control.calls += 1;
      if (control.throwAt !== null && control.seen++ === control.throwAt) {
        throw new Error("わざと落とす");
      }
      return actual.applyMove(...args);
    },
  };
});

const { frameAt, ReplayWalks } = await import("../src/history.js");

describe("指せなかった手で止まるとき", () => {
  /**
   * **止まったときだけ 1 手ずれる、という壊れかたをしていた。** `playedMove` は 1 つ前の
   * 手のままなので、クライアントはその手で使ったカードを 1 手あとの手札から探すことになり、
   * 名前が引けずにインスタンス ID がそのまま画面へ出る。
   */
  it("「指す直前の局面」が、指した手の 1 つ手前のままである", () => {
    ensureCards();
    mkdtempSync(join(tmpdir(), "poke-diverge-"));
    const played = playToEnd(newMatch("diverge-1"), 4177);
    if (played.match.result === null) concede(played.match, 0, 1);
    const record = toRecord(played.match);
    expect(record.moves.length).toBeGreaterThan(4);

    const stopAt = 3;
    /**
     * 呼び出しごとに、途中の局面を何も覚えていない状態から指させる。覚えていると
     * 手前の局面から指し始めるので、差し替えた `applyMove` が数える位置がずれる。
     */
    const sound = frameAt(record, stopAt - 1, undefined, new ReplayWalks());

    control.throwAt = stopAt;
    control.seen = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let stopped;
    try {
      stopped = frameAt(record, record.moves.length, undefined, new ReplayWalks());
    } finally {
      warn.mockRestore();
      control.throwAt = null;
    }

    expect(stopped.divergedAt).toBe(stopAt);
    expect(stopped.ply).toBe(stopAt);
    expect(stopped.playedMove).toEqual(record.moves[stopAt - 1]?.move);
    // 指した手を指す直前の局面。1 手先の局面ではない。
    expect(stopped.beforeViews).toEqual(sound.views);
    expect(stopped.beforeViews).not.toEqual(stopped.views);
  });
});

/**
 * 途中の局面を覚える理由そのもの（6.6 節）。1 手進めるたびに初手から指し直すと、
 * そのあいだ進行中の対戦の手も持ち時間のスイープも止まる。
 * 時間では測らない（手元と CI で速さが違う）。指した回数で数える。
 */
describe("途中の局面を覚えたリプレイ", () => {
  it("1 手ずつ進むときも戻るときも、初手から指し直さない", () => {
    ensureCards();
    const played = playToEnd(newMatch("walks-count"), 59);
    if (played.match.result === null) concede(played.match, 0, 1);
    const record = toRecord(played.match);
    expect(record.moves.length).toBeGreaterThan(40);
    const walks = new ReplayWalks();
    frameAt(record, 40, undefined, walks);

    const appliedFor = (ply: number): number => {
      control.calls = 0;
      frameAt(record, ply, undefined, walks);
      return control.calls;
    };
    // 直前に辿り着いた 40 手目から 1 手。
    expect(appliedFor(41)).toBe(1);
    // 戻るときは、手前の覚えている地点（32 手目）から。
    expect(appliedFor(33)).toBe(1);
    expect(appliedFor(40)).toBe(7);
  });
});
