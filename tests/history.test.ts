/**
 * 済んだ対戦のリプレイ（`docs/spec/battle-server.md` 6.6 節）。
 *
 * 読めるのは自分が指した対戦だけである。それを確かめるのは記録を引く側
 * （`tests/archive.test.ts`）で、ここは引いた記録から盤面を作る側を見る。
 */

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createGame, playerView, projectEvents } from "../src/engine.js";
import type { Move } from "../src/engine.js";
import { toRecord, type MatchRecord } from "../src/log.js";
import { frameAt, isMatchId, replayability } from "../src/history.js";
import { engineFingerprint, OLDEST_REPLAYABLE_SCHEMA_VERSION } from "../src/fingerprint.js";
import { concede } from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

/** 1 局指して、座席の識別子を差し替えた記録を返す。 */
function playedRecord(nonce: string, players: [string, string]): MatchRecord {
  const played = playToEnd(newMatch(nonce), nonce.length * 977 + 13);
  if (played.match.result === null) concede(played.match, 0, 1);
  const base = toRecord(played.match);
  return {
    ...base,
    seats: [
      { ...base.seats[0], playerId: players[0], displayName: players[0] },
      { ...base.seats[1], playerId: players[1], displayName: players[1] },
    ],
  };
}

describe("1 局のリプレイ", () => {
  it("手の数だけ局面を辿れる", () => {
    ensureCards();
    const record = playedRecord("hist-5", ["あ", "い"]);

    const start = frameAt(record, 0);
    expect(start.ply).toBe(0);
    expect(start.playedMove).toBeNull();
    expect(start.moveCount).toBe(record.moves.length);

    const end = frameAt(record, record.moves.length);
    expect(end.ply).toBe(record.moves.length);
    expect(end.playedMove).toEqual(record.moves.at(-1)?.move);

    // 範囲の外は両端に丸める。手で URL をいじっても落ちない。
    expect(frameAt(record, -5).ply).toBe(0);
    expect(frameAt(record, record.moves.length + 100).ply).toBe(record.moves.length);
  });

  /**
   * 手数は整数でしか意味を持たない。丸めずに返すと、盤面は 2 手目の後なのに
   * 応答には 1.5 と書いてあることになり、画面の数えかたがそこからずれる。
   */
  it("整数でない手数は丸めて返す", () => {
    ensureCards();
    const record = playedRecord("hist-12", ["あ", "い"]);

    const half = frameAt(record, 1.5);
    expect(half.ply).toBe(1);
    expect(half.views).toEqual(frameAt(record, 1).views);
    expect(frameAt(record, Number.NaN).ply).toBe(0);
    expect(frameAt(record, Number.POSITIVE_INFINITY).ply).toBe(record.moves.length);
  });

  it("指す直前の盤面も一緒に返す", () => {
    ensureCards();
    const record = playedRecord("hist-7", ["あ", "い"]);

    expect(frameAt(record, 0).beforeViews).toBeNull();
    // 1 手ぶん手前の盤面が、そのまま「直前」である。
    for (const ply of [1, 2, record.moves.length]) {
      expect(frameAt(record, ply).beforeViews).toEqual(frameAt(record, ply - 1).views);
    }
  });

  /**
   * エンジンを直すと、記録された手が合法でなくなることがある。6.3 節は版の違いを警告に
   * とどめると決めているので、**そのまま `applyMove` へ渡してエンジンに投げさせない。**
   * 投げるとエンドポイントはその例外メッセージをそのまま外へ出し、その対戦は食い違う地点より先へ進めなくなる。
   * 再生器（`src/replay.ts`）は同じ地点を `illegal-move` として記録して止まる。
   */
  it("記録された手が合法でなくなっていたら、その手前までを返す", () => {
    ensureCards();
    const record = playedRecord("hist-diverge", ["あ", "い"]);
    // 3 手目を、どの局面でも合法にならない手へ差し替える。版が変わった記録の代わりである。
    const broken: MatchRecord = {
      ...record,
      moves: record.moves.map((logged, index) =>
        index === 3
          ? { ...logged, move: { type: "PlayBasic", cardInstanceId: "p0-999" } as Move }
          : logged,
      ),
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let frame;
    try {
      frame = frameAt(broken, broken.moves.length);
      // 合法手と突き合わせて止めているので、エンジンへは渡らない。渡って投げたぶんは
      // 受け止めたうえで知らせが出る。ここでは出ないことが、止めた場所の証拠になる。
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }

    expect(frame.divergedAt).toBe(3);
    // 手前までは読める。止まるのはこの 1 局のこの地点だけである。
    expect(frame.ply).toBe(3);
    expect(frame.views).toEqual(frameAt(record, 3).views);
    // 記録そのものの手数は変えない。画面は「どこまで辿れるか」をこれと `divergedAt` で読む。
    expect(frame.moveCount).toBe(record.moves.length);
    // 食い違う手前を名指しで頼めば、そこまでは何も起きていない。
    expect(frameAt(broken, 2).divergedAt).toBeNull();
    expect(frameAt(broken, 2).ply).toBe(2);
  });

  it("食い違いが無ければ `divergedAt` は null のまま", () => {
    ensureCards();
    const record = playedRecord("hist-ok", ["あ", "い"]);
    expect(frameAt(record, record.moves.length).divergedAt).toBeNull();
  });

  /**
   * 終わった対戦は、当人どうしには両座席ぶんを見せる（6.6 節）。だから「相手の手札が出る」
   * ことは漏れではない。**それでも射影を通らない値は出さない**というのが 1 節の S-2 で、
   * ここが見るのはそちらである。山札の並びは、終わった対戦でも誰にも渡さない。
   */
  it("射影の結果しか返さない。山札とサイドの中身はリプレイでも渡さない", () => {
    ensureCards();
    const record = playedRecord("hist-6", ["あ", "い"]);
    const frame = frameAt(record, 0);

    const { state, events } = createGame({ seed: record.seed, decks: record.decks });
    expect(frame.views).toEqual([playerView(state, 0), playerView(state, 1)]);
    expect(frame.events).toEqual([projectEvents(events, 0), projectEvents(events, 1)]);

    // 生の局面が混じっていれば、山札とサイドが配列として現れる。射影は枚数しか持たない。
    const payload = JSON.parse(JSON.stringify(frameAt(record, record.moves.length))) as unknown;
    expect(keysOf(payload)).not.toContain("deck");
    expect(keysOf(payload)).not.toContain("prizes");
    expect(keysOf(payload)).toContain("deckCount");
  });
});

describe("対戦の識別子の形", () => {
  it("対戦の識別子の形だけを通す", () => {
    // `randomUUID()` が出す形。
    expect(isMatchId("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toBe(true);
    expect(isMatchId(randomUUID())).toBe(true);

    // 空白だけのもの、1 文字違うもの、パスのようなもの。どれも D1 と R2 を読みに行かせない。
    for (const bad of [
      "",
      " ",
      "   ",
      "\n",
      "べつのかたち",
      "6f9619ff-8b86-d011-b42d-00c04fc964f", // 1 文字足りない
      "6f9619ff-8b86-d011-b42d-00c04fc964ff ", // うしろに空白
      "zzzzzzzz-8b86-d011-b42d-00c04fc964ff", // 16 進でない
      "../../etc/passwd",
      "%",
    ]) {
      expect(isMatchId(bad)).toBe(false);
    }
  });
});

describe("リプレイとエンジンの版", () => {
  it("カードデータが違えば読み返さない", () => {
    ensureCards();
    const record = playedRecord("hist-8", ["あ", "い"]);
    const now = engineFingerprint();

    expect(replayability(record, now)).toEqual({ kind: "ok", engineCommitDiffers: false });
    const other = replayability(record, { ...now, cardDataSha256: "ちがうカードデータ" });
    expect(other.kind).toBe("card-data-mismatch");
  });

  // 版 2 までの seed は 32 ビットの数値で、いまの乱数は同じ値から別の列を出す。
  it("種の読み方が変わる前の版は、盤面を 1 枚も描く前に断る", () => {
    ensureCards();
    const record = playedRecord("hist-10", ["あ", "い"]);
    const now = engineFingerprint();

    expect(replayability({ ...record, schemaVersion: 2 }, now)).toEqual({
      kind: "schema-too-old",
      recorded: 2,
      oldest: OLDEST_REPLAYABLE_SCHEMA_VERSION,
    });
    /**
     * 版番号が欠けた行も断る。ログは `as MatchRecord` で読み直すだけなので、欄が
     * 無い行はここまで来る。`undefined < 3` は false なので、大小の比較では素通りする。
     */
    const { schemaVersion: _dropped, ...missing } = record;
    expect(replayability(missing as MatchRecord, now).kind).toBe("schema-too-old");

    // いまの版はここを通り抜ける。上の断りが版だけを見ていることの裏。
    expect(replayability(record, now).kind).toBe("ok");
  });

  // 種を書き換えたログは、版番号が合っていても別の対戦の盤面を出す。
  it("公開された nonce から seed が導き直せない記録を断る", () => {
    ensureCards();
    const record = playedRecord("hist-11", ["あ", "い"]);
    const now = engineFingerprint();

    const tampered = { ...record, seed: record.seed.replace(/^./, (c) => (c === "0" ? "1" : "0")) };
    expect(replayability(tampered, now)).toEqual({ kind: "seed-commitment-mismatch" });
  });

  /**
   * 断る判断は `replayability` にあるが、盤面を作るのは `frameAt` である。呼ぶ順番だけに
   * 頼ると、断るはずの記録が「誤りの無い別の対戦」として 1 回の呼び出しで出る。
   */
  it("読み返せない記録から盤面を作ろうとすると投げる", () => {
    ensureCards();
    const record = playedRecord("hist-12", ["あ", "い"]);

    // 黙って別の初手を返していたのがこの経路である。
    expect(() => frameAt({ ...record, schemaVersion: 2 }, 0)).toThrow(/読み返せない/);
    expect(() =>
      frameAt({ ...record, seed: record.seed.replace(/^./, (c) => (c === "0" ? "1" : "0")) }, 0),
    ).toThrow(/読み返せない/);
    // 通る記録はこれまでどおり。
    expect(frameAt(record, 0).views).toHaveLength(2);
  });

  it("エンジンの版が違うだけなら読み返せる。ただし警告を付ける", () => {
    ensureCards();
    const record = playedRecord("hist-9", ["あ", "い"]);
    const now = engineFingerprint();
    const older = { ...now, commit: "べつのコミット" };

    // 版を理由に一律で捨てると、直した誤りに触れていない大多数の対戦まで読めなくなる。
    expect(replayability(record, older)).toEqual({ kind: "ok", engineCommitDiffers: true });
    expect(frameAt(record, 1, older).engineCommitDiffers).toBe(true);
    expect(frameAt(record, 1, now).engineCommitDiffers).toBe(false);
  });
});

/** 入れ子をすべて辿って、現れる鍵の名前を集める。 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}
