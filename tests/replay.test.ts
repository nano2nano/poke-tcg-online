/**
 * 対局ログの往復（`docs/spec/battle-server.md` 6 節）。
 *
 * seed と move 列だけを残して、そこから同じ対戦が出ることを確かめる。
 * この往復が通らないログは、AI の学習にとって存在しないのと同じである。
 */

import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { engineFingerprint } from "../src/fingerprint.js";
import { toRecord } from "../src/log.js";
import { concede } from "../src/match.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { replay, seedCommitmentHolds } from "../src/replay.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

describe("対局ログの再生", () => {
  it("seed と move 列だけから同じ対戦が出る", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-1"), 991);
    const record = toRecord(played.match);

    const result = replay(record, { fingerprint: engineFingerprint() });
    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(record.moves.length);
    expect(result.state.outcome).toEqual(record.outcome);
  });

  it("再生の全局面でエンジンの不変条件が成り立つ", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-2"), 1213);
    const record = toRecord(played.match);

    let initialCards: string[] = [];
    const result = replay(record, {
      fingerprint: engineFingerprint(),
      inspect: (state, index) => {
        if (index === 0) initialCards = initialCardIds(state);
        inspectState(state, initialCards);
      },
    });
    expect(result.failures).toEqual([]);
  });

  it("公開された nonce から seed とコミットが導き直せる", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-3"), 55);
    const record = toRecord(played.match);
    expect(seedCommitmentHolds(record)).toBe(true);
    // コミットから seed が出ないこと。接頭辞を分けている理由がこれである。
    expect(record.seedCommit).not.toContain(record.seed.toString(16));
  });

  it("投了で終わった対戦は、指された手までを再生できる", () => {
    ensureCards();
    const match = newMatch("replay-4");
    playToEnd(match, 606, { maxMoves: 12 });
    concede(match, 0, 1_000);
    const record = toRecord(match);

    const result = replay(record, { fingerprint: engineFingerprint() });
    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(record.moves.length);
    expect(record.outcome).toBeNull();
    expect(record.matchResult.kind).toBe("concede");
  });

  it("カードデータが違うログは再生を拒否する", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-5"), 77, { maxMoves: 6 });
    concede(played.match, 1, 0);
    const record = toRecord(played.match);

    const result = replay(record, {
      fingerprint: { commit: engineFingerprint().commit, cardDataSha256: "ちがうハッシュ" },
    });
    expect(result.failures).toEqual([
      {
        kind: "card-data-mismatch",
        expected: record.engine.cardDataSha256,
        actual: "ちがうハッシュ",
      },
    ]);
  });

  it("エンジンの commit の違いは再生を拒否する理由にしない", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-6"), 88);
    const record = toRecord(played.match);

    const result = replay(record, {
      fingerprint: { commit: "べつのコミット", cardDataSha256: record.engine.cardDataSha256 },
    });
    expect(result.engineCommitDiffers).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("手を差し替えたログは非合法手として止まる", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-7"), 99);
    const record = toRecord(played.match);
    const tampered = {
      ...record,
      moves: [
        { move: { type: "EndTurn", player: 0 }, elapsedMs: 0, source: "human" },
        ...record.moves,
      ],
    } as typeof record;

    const result = replay(tampered, { fingerprint: engineFingerprint() });
    expect(result.failures[0]?.kind).toBe("illegal-move");
  });

  it("1 局のログは gzip で 1 KB 台に収まる", () => {
    ensureCards();
    const played = playToEnd(newMatch("replay-8"), 123);
    const line = JSON.stringify(toRecord(played.match));
    // 局面もイベントも保存しない形を選んだ根拠そのもの（6.1 節）。
    expect(gzipSync(line).length).toBeLessThan(4_000);
  });
});
