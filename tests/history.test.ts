/**
 * 済んだ対戦の読み返し（`docs/spec/battle-server.md` 6.6 節）。
 *
 * 読めるのは自分が指した対戦だけである。終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えるなら、それは対戦環境として成り立たない。
 */

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGame, playerView, projectEvents } from "../src/engine.js";
import type { Move } from "../src/engine.js";
import { appendRecord, toRecord, type MatchRecord } from "../src/log.js";
import {
  findMatch,
  forgetOpened,
  frameAt,
  isMatchId,
  listMatches,
  replayability,
} from "../src/history.js";
import { engineFingerprint } from "../src/fingerprint.js";
import { concede } from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

/** 1 局指して、座席の識別子を差し替えてから書き出す。 */
function writeMatch(dir: string, nonce: string, players: [string, string]): MatchRecord {
  const played = playToEnd(newMatch(nonce), nonce.length * 977 + 13);
  if (played.match.result === null) concede(played.match, 0, 1);
  const base = toRecord(played.match);
  const record: MatchRecord = {
    ...base,
    seats: [
      { ...base.seats[0], playerId: players[0], displayName: players[0] },
      { ...base.seats[1], playerId: players[1], displayName: players[1] },
    ],
  };
  appendRecord(record, dir);
  return record;
}

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "poke-history-"));
}

describe("済んだ対戦の一覧", () => {
  it("自分が指した対戦だけを返す", () => {
    ensureCards();
    const dir = newDir();
    writeMatch(dir, "hist-1", ["あ", "い"]);
    writeMatch(dir, "hist-2", ["う", "え"]);

    const mine = listMatches(dir, "あ");
    expect(mine.length).toBe(1);
    expect(mine[0]?.opponentName).toBe("い");
    expect(mine[0]?.seat).toBe(0);
    expect(listMatches(dir, "う").length).toBe(1);
    expect(listMatches(dir, "だれでもない").length).toBe(0);
  });

  it("読み手から見た勝ち負けを返す", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-3", ["あ", "い"]);
    const winner = record.matchResult.winner;

    const forFirst = listMatches(dir, "あ")[0];
    expect(forFirst?.outcome).toBe(winner === 0 ? "win" : "loss");
    const forSecond = listMatches(dir, "い")[0];
    expect(forSecond?.outcome).toBe(winner === 1 ? "win" : "loss");
  });

  /**
   * 追記の最中に落ちれば、書きかけの行が 1 つ残る。そこで例外を投げると、
   * その 1 行のために**全員の**一覧と読み返しが止まる。
   */
  it("読めない行が混じっても、読める対戦は読める", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-10", ["あ", "い"]);
    const path = join(dir, `${record.endedAt.slice(0, 10)}.jsonl`);
    // 書きかけで落ちた行を真似る。
    appendFileSync(path, `${JSON.stringify(record).slice(0, 200)}\n`);
    const second = writeMatch(dir, "hist-11", ["あ", "う"]);

    const mine = listMatches(dir, "あ");
    expect(mine.map((row) => row.matchId).sort()).toEqual([record.matchId, second.matchId].sort());
    expect(findMatch(dir, "あ", second.matchId)?.matchId).toBe(second.matchId);
  });

  it("ログが 1 件も無いところでも落ちない", () => {
    expect(listMatches(join(newDir(), "そんなところは無い"), "あ")).toEqual([]);
  });
});

describe("1 局の読み返し", () => {
  it("指していない対戦は引けない", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-4", ["あ", "い"]);

    expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    // 他人の対戦と、存在しない対戦を、同じ「無い」にする。
    expect(findMatch(dir, "そとのひと", record.matchId)).toBeNull();
    expect(findMatch(dir, "あ", "そんな対戦は無い")).toBeNull();
  });

  it("手の数だけ局面を辿れる", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-5", ["あ", "い"]);

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
    const dir = newDir();
    const record = writeMatch(dir, "hist-12", ["あ", "い"]);

    const half = frameAt(record, 1.5);
    expect(half.ply).toBe(1);
    expect(half.views).toEqual(frameAt(record, 1).views);
    expect(frameAt(record, Number.NaN).ply).toBe(0);
    expect(frameAt(record, Number.POSITIVE_INFINITY).ply).toBe(record.moves.length);
  });

  it("指す直前の盤面も一緒に返す", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-7", ["あ", "い"]);

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
    const dir = newDir();
    const record = writeMatch(dir, "hist-diverge", ["あ", "い"]);
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
    const dir = newDir();
    const record = writeMatch(dir, "hist-ok", ["あ", "い"]);
    expect(frameAt(record, record.moves.length).divergedAt).toBeNull();
  });

  /**
   * 終わった対戦は、当人どうしには両座席ぶんを見せる（6.6 節）。だから「相手の手札が出る」
   * ことは漏れではない。**それでも射影を通らない値は出さない**というのが 1 節の S-2 で、
   * ここが見るのはそちらである。山札の並びは、終わった対戦でも誰にも渡さない。
   */
  it("射影の結果しか返さない。山札とサイドの中身は読み返しでも渡さない", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-6", ["あ", "い"]);
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

/**
 * エンジンの同一性（§6.3）。この規律は再生器がすでに持っていて、読み返しにも同じものを通す。
 * カードの定義が変われば同じ `defId` が別のカードを指しうるので、黙って違う盤面を見せない。
 */
/**
 * 読み返しは 1 手進めるたびに 1 局を引き直す。そのたびに全部の日を走査すると、
 * その間ずっと進行中の対戦の手も持ち時間のスイープも止まる。
 */
describe("開いている対戦を覚えておく", () => {
  it("覚えていても、指していない人には渡さない", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    const record = writeMatch(dir, "hist-13", ["あ", "い"]);

    // まず当人が引いて、覚えさせる。
    expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    // 覚えたものを、指していない人が引けてはいけない。
    expect(findMatch(dir, "そとのひと", record.matchId)).toBeNull();
    expect(findMatch(dir, "い", record.matchId)?.matchId).toBe(record.matchId);
  });

  it("見つからなかったことは覚えない。あとから書かれた対戦も引ける", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    const first = writeMatch(dir, "hist-14", ["あ", "い"]);
    expect(findMatch(dir, "あ", "まだ無い対戦")).toBeNull();

    const later = writeMatch(dir, "hist-15", ["あ", "う"]);
    expect(findMatch(dir, "あ", later.matchId)?.matchId).toBe(later.matchId);
    expect(findMatch(dir, "あ", first.matchId)?.matchId).toBe(first.matchId);
  });
});

/**
 * 読み返しは 1 局を名指しで引く。名指しになっていない値を通すと、事前フィルタが素通りして
 * 全部の日を解析することになる。**プレイヤーは誰でも作れるので、これは繰り返し送れる。**
 * その間は進行中の対戦の手も持ち時間のスイープも止まる。
 */
describe("名指しになっていない識別子では走査しない", () => {
  it("対戦の識別子の形だけを通す", () => {
    // `randomUUID()` が出す形。
    expect(isMatchId("6f9619ff-8b86-d011-b42d-00c04fc964ff")).toBe(true);
    expect(isMatchId(randomUUID())).toBe(true);

    // すべての行に当たるもの、当たらないが走査だけさせるもの、どちらも通さない。
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

  /**
   * 「引けない」だけでは足りない。空の識別子は**走査したうえで**当たらないので、
   * 結果だけ見ると直っていなくても通ってしまう。ここは**走査したかどうか**を見る。
   *
   * 読めない行を 1 つ植えておくと、走査すれば必ず `console.warn` が出る。
   * それが出ないことが、行を 1 つも読んでいないことの証拠になる。
   */
  it("空の識別子では、ログを読みに行きもしない", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    const record = writeMatch(dir, "hist-16", ["あ", "い"]);
    // 形は通るが無い対戦の識別子を持つ、書きかけの行を植える。
    // 事前フィルタはこの行に当たるので、走査すれば必ず解析に失敗して警告が出る。
    const absent = randomUUID();
    appendFileSync(
      join(dir, `${record.endedAt.slice(0, 10)}.jsonl`),
      `{"matchId":"${absent}","moves":[\n`,
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 走査は起きるので、読めない行の警告が出る。
      expect(findMatch(dir, "あ", absent)).toBeNull();
      expect(warn).toHaveBeenCalled();

      // 空文字と空白は、走査そのものが起きない。
      warn.mockClear();
      expect(findMatch(dir, "あ", "")).toBeNull();
      expect(findMatch(dir, "あ", "   ")).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      // 本物はこれまでどおり引ける。
      expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("読み返しとエンジンの版", () => {
  it("カードデータが違えば読み返さない", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-8", ["あ", "い"]);
    const now = engineFingerprint();

    expect(replayability(record, now)).toEqual({ kind: "ok", engineCommitDiffers: false });
    const other = replayability(record, { ...now, cardDataSha256: "ちがうカードデータ" });
    expect(other.kind).toBe("card-data-mismatch");
  });

  it("エンジンの版が違うだけなら読み返せる。ただし警告を付ける", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-9", ["あ", "い"]);
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
