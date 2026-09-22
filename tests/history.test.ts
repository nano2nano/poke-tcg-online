/**
 * 済んだ対戦のリプレイ（`docs/spec/battle-server.md` 6.6 節）。
 *
 * 読めるのは自分が指した対戦だけである。終わった対戦は当人どうしには全部見えてよいが、
 * 他人のデッキと引きが誰にでも見えるなら、それは対戦環境として成り立たない。
 */

import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGame, playerView, projectEvents } from "../src/engine.js";
import type { Move } from "../src/engine.js";
import { appendRecord, toRecord, type MatchRecord } from "../src/log.js";
import {
  findMatch,
  forgetListed,
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

  /**
   * `/api/matches` は誰でも繰り返し呼べる。毎回すべての日を読み直すと、ログが増えるほど
   * イベントループが止まり、対戦中のプレイヤーの持ち時間が削られる。追記しかしないログ
   * なので、いちど読んだバイト列は読み直さずに済む。
   */
  it("いちど読んだところを読み直さず、追記ぶんだけを読み足す", () => {
    ensureCards();
    const dir = newDir();
    forgetListed();
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
      const second = writeMatch(dir, "hist-cache", ["あ", "う"]);
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

  /**
   * `seed` の幅を変えた日（§9.1）。古いレコードは数値の seed を持っていて、いまのエンジンは
   * それを受け取れるが、別の対戦になる。**断らずに、読めるところまで返し続けること**が
   * §6.3 の決めなので、一覧からも再生からも消えないことを見る。
   */
  it("seed が数値だった頃の記録は、一覧に出たまま途中で止まる", () => {
    ensureCards();
    const dir = newDir();
    const record = writeMatch(dir, "hist-old-seed", ["あ", "い"]);
    const old: MatchRecord = {
      ...record,
      matchId: randomUUID(),
      schemaVersion: 2,
      // 幅を変える前に書かれた形。型の上では文字列だが、実データは数値である。
      seed: 1234 as unknown as string,
    };
    appendRecord(old, dir);
    forgetListed();
    forgetOpened();

    // 正規データは変わっていないので、拒否ではなく警告どまりである。
    expect(replayability(old)).toEqual({ kind: "ok", engineCommitDiffers: false });
    expect(listMatches(dir, "あ").map((listed) => listed.matchId)).toContain(old.matchId);

    const frame = frameAt(old, old.moves.length);
    expect(frame.divergedAt).not.toBeNull();
    // 手の列そのものは読める。消えるのは盤面だけである。
    expect(frame.moveCount).toBe(record.moves.length);
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
 * エンジンの同一性（§6.3）。この規律は再生器がすでに持っていて、リプレイにも同じものを通す。
 * カードの定義が変われば同じ `defId` が別のカードを指しうるので、黙って違う盤面を見せない。
 */
/**
 * リプレイは 1 手進めるたびに 1 局を引き直す。そのたびに全部の日を走査すると、
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
 * リプレイは 1 局を名指しで引く。名指しになっていない値を通すと、事前フィルタが素通りして
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
  /**
   * **形の合う識別子は誰でもいくらでも作れる。** 外れを 1 つずつ覚える手は効かないが、
   * 一覧のキャッシュは在る対戦の識別子を持っているので、そこに無ければ読む必要がない。
   */
  it("無い対戦を名指しされても、2 度目からはログを読み直さない", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    forgetListed();
    const record = writeMatch(dir, "hist-17", ["あ", "い"]);
    // 読めない行を植える。読みに行けば必ず警告が出るので、出ないことが読んでいない証拠になる。
    appendFileSync(join(dir, `${record.endedAt.slice(0, 10)}.jsonl`), `{"matchId":"こわれた"\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 1 度目はキャッシュを作るので読む。
      expect(findMatch(dir, "あ", randomUUID())).toBeNull();
      expect(warn).toHaveBeenCalled();

      // 2 度目からは、識別子を変えられても読み直さない。
      warn.mockClear();
      for (let i = 0; i < 20; i++) expect(findMatch(dir, "あ", randomUUID())).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      // 本物はこれまでどおり引ける。
      expect(findMatch(dir, "あ", record.matchId)?.matchId).toBe(record.matchId);
    } finally {
      warn.mockRestore();
    }
  });

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

/**
 * キャッシュが溢れたとき、**残すのは新しい日である。** いちばん伸びるのは今日のファイルで、
 * 伸びるたびに丸ごと読み直すことになれば、キャッシュを置いた意味が無くなる。
 * 捨てる向きが決まっていないと、古い日と新しい日が毎回お互いを追い出し続ける。
 */
describe("キャッシュが溢れたとき", () => {
  it("いま伸びている日を残し、読み直しが繰り返されない", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    // 日を 2 つぶん置いて、合わせて上限を超える形にする。
    forgetListed(3);

    const old = writeMatch(dir, "hist-20", ["あ", "い"]);
    const oldDay = join(dir, `${old.endedAt.slice(0, 10)}.jsonl`);
    appendFileSync(oldDay, `${JSON.stringify({ ...old, matchId: randomUUID() })}\n`);

    // 今日のぶん。読めない行を植えておく。頭から読み直せば必ず警告が出る。
    const todayDay = join(dir, "2099-01-01.jsonl");
    writeFileSync(todayDay, `${JSON.stringify({ ...old, matchId: randomUUID() })}\n`, "utf8");
    appendFileSync(todayDay, `{"matchId":"こわれた"\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listMatches(dir, "あ").length).toBe(3);
      expect(warn).toHaveBeenCalled();

      // 今日のファイルが伸びる。ここで今日のぶんを捨てると、次から毎回読み直しになる。
      appendFileSync(todayDay, `${JSON.stringify({ ...old, matchId: randomUUID() })}\n`);
      warn.mockClear();
      // 何度呼んでも、今日のファイルを頭から読み直さない（読み直せば植えた行で警告が出る）。
      for (let i = 0; i < 5; i++) expect(listMatches(dir, "あ").length).toBe(4);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      forgetListed();
    }
  });

  /**
   * **1 日だけで上限を超えても、いちばん新しい日は覚える。** そこがいちばん読まれて、
   * いちばん伸びる。覚えないと毎回そのファイルを頭から読むことになり、上限を置いた目的
   * （イベントループを止めない）と逆のことが起きる。古い日は読み直しになるが、
   * そちらは伸びないので、読み直しの大きさは増えない。
   */
  it("1 日だけで上限を超えても、いちばん新しい日は覚える", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    forgetListed(2);

    const old = writeMatch(dir, "hist-21", ["あ", "い"]);

    // 上限（2）を 1 日だけで超える、いちばん新しい日。読めない行を植えておく。
    const big = join(dir, "2099-12-31.jsonl");
    writeFileSync(
      big,
      [0, 1, 2]
        .map((i) => `${JSON.stringify({ ...old, matchId: `${randomUUID()}-${i}` })}\n`)
        .join(""),
      "utf8",
    );
    appendFileSync(big, `{"matchId":"こわれた"\n`);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listMatches(dir, "あ").length).toBe(4);
      expect(warn).toHaveBeenCalled();

      // 2 度目からは、その日を頭から読み直さない。読み直せば植えた行の警告が出る。
      warn.mockClear();
      for (let i = 0; i < 3; i++) expect(listMatches(dir, "あ").length).toBe(4);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      forgetListed();
    }
  });
});

/**
 * 一覧とリプレイは、**同じファイルの集合**を見なければならない。片方だけが拾うと、
 * 一覧に出るのに開けない対戦ができる。アカウントの保存先を同じディレクトリに置くと、
 * それを対戦記録として読んで警告を出すことにもなる。
 */
describe("一覧とリプレイが見るファイル", () => {
  it("日付の名前でないファイルは、一覧もリプレイも読まない", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    forgetListed();
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
 * ファイルが縮んだことは読むだけでは分からない。**読んだかどうかで覚え直すと、
 * 0 バイトに縮んだ日は読むものが無く、古いほうが上限を食ったまま残る。**
 * `logrotate` の `copytruncate` は、まさにこれを起こす。
 */
describe("縮んだ日のキャッシュ", () => {
  it("0 バイトに縮んだ日を、古いままにしない", () => {
    const dir = newDir();
    forgetOpened();
    forgetListed(3);
    try {
      const first = writeMatch(dir, "hist-21", ["あ", "い"]);
      const day = join(dir, `${first.endedAt.slice(0, 10)}.jsonl`);
      expect(listMatches(dir, "あ").length).toBe(1);

      // 中身だけ捨てる（ファイルは残る）。一覧からも消える。
      writeFileSync(day, "", "utf8");
      expect(listMatches(dir, "あ").length).toBe(0);

      /**
       * 古いほうが残っていると、そのぶん上限を食う。ここでは上限 3 に対して
       * 1 つ残っている形になり、**2 日ぶんしか入らなくなる。**
       */
      appendFileSync(day, `${JSON.stringify({ ...first, matchId: randomUUID() })}\n`);
      appendFileSync(day, `${JSON.stringify({ ...first, matchId: randomUUID() })}\n`);
      appendFileSync(day, `${JSON.stringify({ ...first, matchId: randomUUID() })}\n`);
      expect(listMatches(dir, "あ").length).toBe(3);

      // 上限ちょうどなので、覚えられている。読み直せば植えた行で警告が出る。
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
    } finally {
      forgetListed();
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
 * 行が頭から欠けて読めなくなる。読めなくなった対戦は一覧から消え、`isListed` が `findMatch` を
 * 塞ぐのでリプレイも引けない。
 */
describe("文字の途中で切れた追記", () => {
  it("そのあとに足した対戦も、キャッシュ経由で見える", () => {
    ensureCards();
    const dir = newDir();
    forgetOpened();
    forgetListed();

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
