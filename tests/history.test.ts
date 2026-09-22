/**
 * 済んだ対戦のリプレイ（`docs/spec/battle-server.md` 6.6 節）。
 *
 * 読めるのは自分が指した対戦だけである。終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えるなら、それは対戦環境として成り立たない。
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGame, playerView, projectEvents } from "../src/engine.js";
import type { Move } from "../src/engine.js";
import { appendRecord, toRecord, type MatchRecord } from "../src/log.js";
import { findMatch, frameAt, isMatchId, listMatches, replayability } from "../src/history.js";
import { closeIndexes } from "../src/match-index.js";
import { engineFingerprint, OLDEST_REPLAYABLE_SCHEMA_VERSION } from "../src/fingerprint.js";
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

/** 索引はテストごとに別のディレクトリへ作られる。開いたぶんは最後に閉じる。 */
afterAll(() => closeIndexes());

/** 索引のファイルを消す。正本の JSONL は残す。 */
function dropIndex(dir: string): void {
  closeIndexes();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(join(dir, `index.sqlite${suffix}`), { force: true });
  }
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

  /**
   * `/api/matches` は誰でも繰り返し呼べる。毎回すべての日を読み直すと、ログが増えるほど
   * イベントループが止まり、対戦中のプレイヤーの持ち時間が削られる。追記しかしないログ
   * なので、いちど読んだバイト列は読み直さずに済む。
   */
  it("いちど読んだところを読み直さず、追記ぶんだけを読み足す", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const first = writeMatch(dir, "hist-cache", ["あ", "い"]);
    const day = join(dir, `${first.endedAt.slice(0, 10)}.jsonl`);
    // 読めない行は読んだときに知らせが出る。これを「読んだかどうか」の目印に使う。
    appendFileSync(day, "{壊れている\n");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listMatches(dir, "あ").length).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      expect(listMatches(dir, "あ").length).toBe(1);
      expect(warn).not.toHaveBeenCalled();

      // 追記されたぶんは読む。壊れた行はもう読まない。
      const second = writeMatch(dir, "hist-cache-2", ["あ", "う"]);
      expect(second.endedAt.slice(0, 10)).toBe(first.endedAt.slice(0, 10));
      expect(listMatches(dir, "あ").length).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
   * その 1 行のために**全員の**一覧とリプレイが止まる。
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

describe("1 局のリプレイ", () => {
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
  it("射影の結果しか返さない。山札とサイドの中身はリプレイでも渡さない", () => {
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
 * リプレイは 1 手進めるたびに 1 局を引き直す。索引はその 1 行の位置を持っているので、
 * 読むのはその 1 行だけである。**位置を持っていることと、読んでよいかは別の話である。**
 */
describe("索引から 1 局を引く", () => {
  it("索引にあっても、指していない人には渡さない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const record = writeMatch(dir, "hist-13", ["あ", "い"]);

    expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    // 索引を引けることと、その対戦を読めることを取り違えない。
    expect(findMatch(dir, "そとのひと", record.matchId)).toBeNull();
    expect(findMatch(dir, "い", record.matchId)?.matchId).toBe(record.matchId);
  });

  it("見つからなかったことは覚えない。あとから書かれた対戦も引ける", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const first = writeMatch(dir, "hist-14", ["あ", "い"]);
    expect(findMatch(dir, "あ", "まだ無い対戦")).toBeNull();

    const later = writeMatch(dir, "hist-15", ["あ", "う"]);
    expect(findMatch(dir, "あ", later.matchId)?.matchId).toBe(later.matchId);
    expect(findMatch(dir, "あ", first.matchId)?.matchId).toBe(first.matchId);
  });

  /**
   * **索引が持つのはバイトの位置なので、1 バイトずれれば別の対戦が読める。**
   * 同じ日のファイルに何局も並ぶので、位置がずれても `JSON.parse` は通りうる。
   * 引いた識別子と読めた識別子が一致することまで見る。
   */
  it("同じ日に並んだ対戦を、それぞれ取り違えずに引く", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const written = ["hist-row-1", "hist-row-2", "hist-row-3", "hist-row-4"].map((nonce) =>
      writeMatch(dir, nonce, ["あ", nonce]),
    );
    expect(new Set(written.map((r) => r.endedAt.slice(0, 10))).size).toBe(1);

    for (const record of written) {
      const found = findMatch(dir, "あ", record.matchId);
      expect(found?.matchId).toBe(record.matchId);
      expect(found?.seats[1]?.displayName).toBe(record.seats[1].displayName);
      expect(found?.moves.length).toBe(record.moves.length);
    }
  });
});

/**
 * リプレイは 1 局を名指しで引く。形になっていない値を 404 ではなく 400 で断るための線である。
 */
describe("対戦の識別子の形", () => {
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
   * **形の合う識別子は誰でもいくらでも作れる。** 走査していた頃は、外れの 1 つ 1 つが
   * ログ全体の読み直しになった。索引を引く形では、外れは索引に当たらないだけで、
   * ログは 1 バイトも読まない。
   *
   * 読めない行を 1 つ植えておくと、ログを読み直せば必ず `console.warn` が出る。
   * それが出ないことが、行を 1 つも読み直していないことの証拠になる。
   */
  it("無い対戦を名指しされても、ログを読み直さない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const record = writeMatch(dir, "hist-17", ["あ", "い"]);
    appendFileSync(join(dir, `${record.endedAt.slice(0, 10)}.jsonl`), `{"matchId":"こわれた"\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 1 度目は索引を作るので読む。
      expect(findMatch(dir, "あ", randomUUID())).toBeNull();
      expect(warn).toHaveBeenCalled();

      // 2 度目からは、識別子を変えられても読み直さない。
      warn.mockClear();
      for (let i = 0; i < 20; i++) expect(findMatch(dir, "あ", randomUUID())).toBeNull();
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

/**
 * **索引は消しても作り直せる。** 正本は JSONL で、索引はそこから導いた値しか持たない。
 * これが崩れると、索引はもう「消してよいキャッシュ」ではなく、失われる記録になる。
 */
describe("索引を消したとき", () => {
  it("消しても、同じ一覧と同じ 1 局が読める", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const first = writeMatch(dir, "hist-drop-1", ["あ", "い"]);
    const second = writeMatch(dir, "hist-drop-2", ["あ", "う"]);

    const before = listMatches(dir, "あ");
    expect(before.map((row) => row.matchId).sort()).toEqual([first.matchId, second.matchId].sort());

    dropIndex(dir);

    expect(listMatches(dir, "あ")).toEqual(before);
    expect(findMatch(dir, "あ", second.matchId)?.matchId).toBe(second.matchId);
  });

  /**
   * 索引が読めないことは「まだ作っていない」と同じにする。ここで投げると、
   * **索引のせいで対戦の記録が 1 局も読めなくなる。**
   */
  it("壊れた索引は作り直す。対戦は読めたままである", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const record = writeMatch(dir, "hist-broken-index", ["あ", "い"]);
    expect(listMatches(dir, "あ").length).toBe(1);

    dropIndex(dir);
    writeFileSync(join(dir, "index.sqlite"), "これは SQLite のファイルではない", "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listMatches(dir, "あ").length).toBe(1);
      expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * **索引はプロセスの外に残る。** メモリ上のキャッシュだった頃は、起動し直すたびに
 * ログ全体を読み直していた（実測で 24,000 局・1.6 秒。その間ずっと対戦の時計が進む）。
 * どこまで読んだかを索引の側に持たせると、その読み直しが消える。
 */
describe("起動し直したとき", () => {
  it("すでに索引へ入れた日を、頭から読み直さない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const record = writeMatch(dir, "hist-restart", ["あ", "い"]);
    // 読めない行を植える。読み直せば必ず警告が出るので、出ないことが読んでいない証拠になる。
    appendFileSync(join(dir, `${record.endedAt.slice(0, 10)}.jsonl`), `{"matchId":"こわれた"\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listMatches(dir, "あ").length).toBe(1);
      expect(warn).toHaveBeenCalled();

      // 起動し直す。索引のファイルは残したまま、開いているものだけを手放す。
      closeIndexes();
      warn.mockClear();

      expect(listMatches(dir, "あ").length).toBe(1);
      expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 古い日を別の置き場へ移す運用（`logrotate` が消すのも同じ）で、ファイルが消えることがある。
 * 消えたぶんが索引に残ると、**一覧には出るのに開けない対戦**になる。
 */
describe("日のファイルが消えたとき", () => {
  it("消えた日のぶんは、一覧からもリプレイからも落ちる", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const record = writeMatch(dir, "hist-vanish", ["あ", "い"]);
    const day = join(dir, `${record.endedAt.slice(0, 10)}.jsonl`);
    expect(listMatches(dir, "あ").length).toBe(1);

    rmSync(day);

    expect(listMatches(dir, "あ")).toEqual([]);
    expect(findMatch(dir, "あ", record.matchId)).toBeNull();
  });
});

describe("一覧とリプレイが見るファイル", () => {
  it("日付の名前でないファイルは、一覧もリプレイも読まない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const listed = writeMatch(dir, "hist-18", ["あ", "い"]);

    // 対戦記録として正しいが、日付の名前でないファイルに置いたもの。
    const hidden = writeMatch(newDir(), "hist-19", ["あ", "い"]);
    writeFileSync(join(dir, "accounts.jsonl"), `${JSON.stringify(hidden)}\n`, "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = listMatches(dir, "あ").map((summary) => summary.matchId);
      expect(ids).toEqual([listed.matchId]);
      expect(findMatch(dir, "あ", hidden.matchId)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("リプレイとエンジンの版", () => {
  it("カードデータが違えば読み返さない", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-8", ["あ", "い"]);
    const now = engineFingerprint();

    expect(replayability(record, now)).toEqual({ kind: "ok", engineCommitDiffers: false });
    const other = replayability(record, { ...now, cardDataSha256: "ちがうカードデータ" });
    expect(other.kind).toBe("card-data-mismatch");
  });

  // 版 2 までの seed は 32 ビットの数値で、いまの乱数は同じ値から別の列を出す。
  it("種の読み方が変わる前の版は、盤面を 1 枚も描く前に断る", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-10", ["あ", "い"]);
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
    const dir = newDir();
    const record = writeMatch(dir, "hist-11", ["あ", "い"]);
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
    const dir = newDir();
    const record = writeMatch(dir, "hist-12", ["あ", "い"]);

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

/**
 * **同じ大きさのまま中身が差し替わると、索引は古いままになる。** 位置だけが合っているので、
 * 引いた対戦とは別の対戦の行が読める。識別子は長さの決まった UUID なので、1 局ぶんの行が
 * 同じ長さのまま入れ替わることは形のうえでは起こりうる。
 *
 * ここで「読めたのだから返す」と倒すと、**その人に、頼んだのとは別の対戦の盤面が出る。**
 * 索引は消しても作り直せるものという建て付けなので、信じきらない側に倒す。
 */
describe("索引が古くなったとき", () => {
  it("引いた対戦と読めた対戦が違えば、渡さない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const first = writeMatch(dir, "hist-stale-1", ["あ", "い"]);
    const second = writeMatch(dir, "hist-stale-2", ["あ", "う"]);
    const day = join(dir, `${first.endedAt.slice(0, 10)}.jsonl`);
    expect(listMatches(dir, "あ").length).toBe(2);

    // 識別子だけを入れ替える。行の長さも、ファイルの大きさも変わらない。
    const swapped = [
      JSON.stringify({ ...first, matchId: second.matchId }),
      JSON.stringify({ ...second, matchId: first.matchId }),
    ];
    const before = statSync(day).size;
    writeFileSync(day, `${swapped.join("\n")}\n`, "utf8");
    expect(statSync(day).size).toBe(before);

    // 索引はまだ入れ替わる前の位置を指している。そこを読んでも、渡さない。
    expect(findMatch(dir, "あ", first.matchId)).toBeNull();
    expect(findMatch(dir, "あ", second.matchId)).toBeNull();

    // 正本は触っていないので、索引を作り直せば読める。
    dropIndex(dir);
    expect(findMatch(dir, "あ", first.matchId)?.seats[1]?.displayName).toBe("う");
  });
});

/**
 * ファイルが縮んだことは、読み足すだけでは分からない。**索引は 1 行ぶんのバイトの位置を持つので、
 * 縮んだ日の行が残っていると、位置だけ合っている別の対戦の行を読むことになる。**
 * `logrotate` の `copytruncate` は、まさにこれを起こす。
 */
describe("縮んだ日", () => {
  it("0 バイトに縮んだ日の対戦を、索引に残さない", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();
    const first = writeMatch(dir, "hist-21", ["あ", "い"]);
    const day = join(dir, `${first.endedAt.slice(0, 10)}.jsonl`);
    expect(listMatches(dir, "あ").length).toBe(1);

    // 中身だけ捨てる（ファイルは残る）。一覧からも消える。
    writeFileSync(day, "", "utf8");
    expect(listMatches(dir, "あ").length).toBe(0);
    expect(findMatch(dir, "あ", first.matchId)).toBeNull();

    /**
     * **同じ長さの行で埋め直す。** 識別子は長さの決まった UUID なので、縮んだことを
     * 見落とすと、消えたはずの対戦の位置に別の対戦の行が来て、そのまま読めてしまう。
     */
    const refilled = [randomUUID(), randomUUID(), randomUUID()];
    for (const matchId of refilled) {
      appendFileSync(day, `${JSON.stringify({ ...first, matchId })}\n`);
    }
    expect(
      listMatches(dir, "あ")
        .map((row) => row.matchId)
        .sort(),
    ).toEqual([...refilled].sort());
    expect(findMatch(dir, "あ", first.matchId)).toBeNull();
    expect(findMatch(dir, "あ", refilled[0] as string)?.matchId).toBe(refilled[0]);

    // 読み直しは 1 度きりである。読み直せば植えた行で警告が出る。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      appendFileSync(day, `{"matchId":"こわれた"\n`);
      expect(listMatches(dir, "あ").length).toBe(3);
      warn.mockClear();
      expect(listMatches(dir, "あ").length).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/** 入れ子をすべて辿って、現れる鍵の名前を集める。 */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}

/**
 * 追記は、多バイト文字の**途中で**落ちうる。表示名が日本語である以上、端数が残る形は普通に起きる。
 * 読み足した位置をバイト列でなく復号した文字列で数えると、その端数が U+FFFD 1 文字（3 バイト）に
 * 化けたぶんだけ位置が進みすぎる。ずれは次に読むときへ持ち越されるので、**その後に足した対戦**の
 * 行が頭から欠けて読めなくなる。索引は 1 行ぶんの位置と長さを持つので、ずれたぶんは
 * 一覧から消えるだけでなく、**名指しで引いたときに別の位置を読む**ことになる。
 */
describe("文字の途中で切れた追記", () => {
  it("そのあとに足した対戦も、索引から引ける", () => {
    ensureCards();
    const dir = newDir();
    closeIndexes();

    const first = writeMatch(dir, "hist-torn-1", ["ふやふ", "あいて"]);
    const day = join(dir, `${first.endedAt.slice(0, 10)}.jsonl`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // ここまでを読んでキャッシュに載せる。
      expect(listMatches(dir, "ふやふ").map((m) => m.matchId)).toEqual([first.matchId]);

      // 「ふ」= E3 81 B5 の 2 バイトめで落ちた追記。行として閉じていない。
      appendFileSync(day, Buffer.from([0x7b, 0xe3, 0x81]));
      appendFileSync(day, "\n");

      // ここを読んだ時点で、次に読む位置がずれる。
      const second = writeMatch(dir, "hist-torn-2", ["ふやふ", "あいて"]);
      expect(listMatches(dir, "ふやふ").map((m) => m.matchId)).toContain(second.matchId);

      // ずれていれば、この行は頭が欠けて読めない。
      const third = writeMatch(dir, "hist-torn-3", ["ふやふ", "あいて"]);
      expect(listMatches(dir, "ふやふ").map((m) => m.matchId)).toContain(third.matchId);
      // 名指しで引くほうも、一覧と同じものを見る。
      expect(findMatch(dir, "ふやふ", third.matchId)?.matchId).toBe(third.matchId);
    } finally {
      warn.mockRestore();
    }
  });
});
