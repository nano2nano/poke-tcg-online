/**
 * リプレイの局面のキャッシュ（`docs/spec/battle-server.md` 6.6 節）。
 *
 * 置くのは速さのためだけで、**返す盤面はキャッシュが無いときと 1 つも変わってはいけない。**
 * 比べる相手は、呼び出しごとに空の `ReplayCache` で初手から指し直した盤面である。
 */

import { describe, expect, it } from "vitest";
import type { Move } from "../src/engine.js";
import { createRng, nextInt } from "../src/engine.js";
import { toRecord, type MatchRecord } from "../src/log.js";
import { frameAt, ReplayCache } from "../src/history.js";
import { concede } from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

/**
 * 終わった対戦の記録。チェックポイントの間隔を何度かまたぐよう、40 手を越えるものを選ぶ。
 * ランダムな手では早く決着する対戦もあるので、越えるまで手の選び方を変えて指し直す。
 */
function finishedRecord(nonce: string, rngSeed: number): MatchRecord {
  for (let attempt = 0; ; attempt++) {
    const played = playToEnd(newMatch(nonce), rngSeed + attempt);
    if (played.match.result === null) concede(played.match, 0, 1);
    const record = toRecord(played.match);
    if (record.moves.length > 40) return record;
  }
}

/** キャッシュの空の状態から作った盤面。比べる基準にする。 */
function fresh(record: MatchRecord, ply: number) {
  return frameAt(record, ply, undefined, new ReplayCache());
}

/**
 * リプレイで起きる順番を並べる。1 手ずつ進む、1 手ずつ戻る、最後へ飛ぶ、最初へ戻る、
 * チェックポイントの境目の前後、手数の外。
 */
function askedPlies(moveCount: number, rngSeed: number): number[] {
  const plies: number[] = [];
  for (let ply = 0; ply <= Math.min(moveCount, 40); ply++) plies.push(ply);
  plies.push(moveCount, moveCount + 5, 0);
  for (let ply = Math.min(moveCount, 40); ply >= 0; ply -= 3) plies.push(ply);
  for (const edge of [15, 16, 17, 31, 32, 33, 64]) if (edge <= moveCount) plies.push(edge);
  let rng = createRng(rngSeed);
  for (let index = 0; index < 30; index++) {
    const [ply, next] = nextInt(rng, moveCount + 1);
    rng = next;
    plies.push(ply);
  }
  return plies;
}

describe("リプレイのキャッシュ", () => {
  it("どの順で頼んでも、初手から指し直したのと同じ盤面を返す", () => {
    ensureCards();
    for (const [nonce, rngSeed] of [
      ["cache-1", 11],
      ["cache-2", 23],
    ] as const) {
      const record = finishedRecord(nonce, rngSeed);
      const cache = new ReplayCache();
      for (const ply of askedPlies(record.moves.length, rngSeed)) {
        expect(frameAt(record, ply, undefined, cache), `${nonce} ${ply} 手`).toEqual(
          fresh(record, ply),
        );
      }
    }
  });

  it("指せない地点をキャッシュに持ったあとも、持つ前と同じ答えを返す", () => {
    ensureCards();
    const record = finishedRecord("cache-diverge", 31);
    const stopAt = 20;
    const broken: MatchRecord = {
      ...record,
      moves: record.moves.map((logged, index) =>
        index === stopAt
          ? { ...logged, move: { type: "PlayBasic", cardInstanceId: "p0-999" } as Move }
          : logged,
      ),
    };
    const cache = new ReplayCache();
    for (const ply of [broken.moves.length, 5, stopAt, stopAt + 1, 19, broken.moves.length]) {
      expect(frameAt(broken, ply, undefined, cache), `${ply} 手`).toEqual(fresh(broken, ply));
    }
  });

  /**
   * **対戦 ID で引かない。** 同じ ID で中身の違う記録に、前に読んだ別の記録の盤面を返すと、
   * 読む人にはそれが別の対戦だと分からない。ここでは食い違いをキャッシュに持った記録のあとで、
   * 同じ ID の食い違わない記録を読む。ID で引いていれば、途中で止まったまま返る。
   */
  it("同じ対戦 ID でも、中身の違う記録どうしでキャッシュを使い回さない", () => {
    ensureCards();
    const record = finishedRecord("cache-same-id", 47);
    const broken: MatchRecord = {
      ...record,
      moves: record.moves.map((logged, index) =>
        index === 3
          ? { ...logged, move: { type: "PlayBasic", cardInstanceId: "p0-999" } as Move }
          : logged,
      ),
    };
    const cache = new ReplayCache();
    expect(frameAt(broken, broken.moves.length, undefined, cache).divergedAt).toBe(3);

    const end = frameAt(record, record.moves.length, undefined, cache);
    expect(end.divergedAt).toBeNull();
    expect(end).toEqual(fresh(record, record.moves.length));
  });

  it("キャッシュの上限を越えても、盤面は変わらない", () => {
    ensureCards();
    const records = [
      finishedRecord("cache-lru-1", 3),
      finishedRecord("cache-lru-2", 5),
      finishedRecord("cache-lru-3", 7),
    ];
    const cache = new ReplayCache(2);
    for (let round = 0; round < 2; round++) {
      for (const record of records) {
        const ply = Math.min(record.moves.length, 20 + round);
        expect(frameAt(record, ply, undefined, cache)).toEqual(fresh(record, ply));
      }
    }
  });
});
