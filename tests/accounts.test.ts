/**
 * プレイヤーとレーティング（`docs/spec/battle-server.md` 7.2 節）。
 *
 * レーティングは体験のためではなく記録のためにある。座席と人をあとから結び直すことは
 * できないので、ここが壊れていると、集めた対局からプレイヤーの強さが永久に失われる。
 */

import { describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, INITIAL_RATING, K_FACTOR } from "../src/accounts.js";

function newStore(): { store: AccountStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "poke-accounts-"));
  return { store: new AccountStore(dir), dir };
}

describe("プレイヤー", () => {
  it("作ったプレイヤーをシークレットで引ける", () => {
    const { store } = newStore();
    const { account, secret } = store.create("あ", 0);

    expect(account.rating).toBe(INITIAL_RATING);
    expect(account.games).toBe(0);
    expect(store.bySecret(secret)?.playerId).toBe(account.playerId);
    expect(store.bySecret("ちがうシークレット")).toBeNull();
  });

  // シークレットが保存されていると、ストアのファイルが漏れただけで他人の対戦に入れる。
  it("シークレットそのものを保存しない", () => {
    const { store, dir } = newStore();
    const { secret } = store.create("あ", 0);

    const saved = readFileSync(join(dir, "accounts.jsonl"), "utf8");
    expect(saved).not.toContain(secret);
  });

  // 識別子は対局ログに残る。シークレットと同じ値だと、ログがシークレットの一覧になる。
  it("公開の識別子とシークレットを別の値にする", () => {
    const { store } = newStore();
    const { account, secret } = store.create("あ", 0);
    expect(account.playerId).not.toBe(secret);
  });

  it("制御文字を落とし、名無しには既定の名を当てる", () => {
    const { store } = newStore();
    expect(store.create("あ\u0000い\nう", 0).account.displayName).toBe("あいう");
    expect(store.create("   ", 0).account.displayName).toBe("ななし");
    expect(store.create("あ".repeat(100), 0).account.displayName.length).toBe(40);
  });

  /**
   * 表示名は画面と対局ログの両方へ出る。UTF-16 の長さで切ると、絵文字のような
   * 2 つ組の文字が半分になったものが、そのままストアにも記録にも入る。
   */
  it("長い名前を切るとき、文字を割らない", () => {
    const { store } = newStore();
    // どれも 1 文字で、UTF-16 では 2 つぶんの長さを持つ。
    const long = "🎴".repeat(100);
    const name = store.create(long, 0).account.displayName;

    expect([...name]).toHaveLength(40);
    expect(name).toBe("🎴".repeat(40));
    // 半端な片割れが残っていない。残っていれば往復で形が変わる。
    expect(JSON.parse(JSON.stringify(name))).toBe(name);
    expect(name).not.toContain("\uFFFD");
    expect([...name].every((char) => char === "🎴")).toBe(true);

    // 2 つ組と普通の文字が混じっていても、数えるのは文字のほうである。
    const mixed = store.create(`${"🎴".repeat(39)}あいう`, 0).account.displayName;
    expect([...mixed]).toHaveLength(40);
    expect(mixed.endsWith("あ")).toBe(true);
  });

  /**
   * 表示名は一覧にも対局ログにも出る。見えない字を通すと、並んだ名前が
   * 読み手の目に別のものとして映る。
   */
  it("見えない字を落とし、字を繋ぐものは残す", () => {
    const { store } = newStore();
    const name = (raw: string) => store.create(raw, 0).account.displayName;

    // どれも 0x20 より上にあるが、画面には出ない。
    expect(name("あ\u007fい\u0085う\u009f")).toBe("あいう");
    expect(name("あ\ufeffい")).toBe("あい");
    // 向きを変える字。残すと、一覧に並んだ名前がうしろから読める形で出る。
    expect(name("あいう\u202e")).toBe("あいう");
    expect(name("\u202eあいう")).toBe("あいう");
    // 相方を失った片割れは、書き出すときに別の値へ化ける。
    expect(name("あ\ud800い")).toBe("あい");
    // 見えない字だけの名前は、何も付けていないのと同じである。
    expect(name("\u202e\u200b\u00ad")).toBe("ななし");

    // ZWJ は絵文字を 1 つに繋ぐ。落とすと 3 人が並んだ別の字になる。
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(name(family)).toBe(family);
    // 繋ぐ相手のいない端の繋ぎ字は、それだけでは字にならない。
    expect(name("\u200dあい\u200d")).toBe("あい");
  });

  it("表示名を変えてもレーティングと戦績は動かない", () => {
    const { store } = newStore();
    const { account, secret } = store.create("まえ", 0);
    const other = store.create("あいて", 0);
    store.applyResult([account.playerId, other.account.playerId], 1, 0);
    const won = store.bySecret(secret);

    const renamed = store.rename(secret, "あと", 1);
    expect(renamed?.displayName).toBe("あと");
    expect(renamed?.rating).toBe(won?.rating);
    expect(renamed?.games).toBe(1);
  });

  /**
   * `/api/account` はログインなしで繰り返し呼べる。全体を書き直していると、1 回の書き込みが
   * 登録数に比例して伸び、同期で書くぶんだけイベントループが止まる。
   */
  it("1 つ変わったときに書くのは、変わったぶんだけ", () => {
    const { store, dir } = newStore();
    const path = join(dir, "accounts.jsonl");
    for (let i = 0; i < 20; i++) store.create(`p${i}`, 0);
    const { secret } = store.create("あとから", 0);
    store.rename(secret, "なまえ", 1);

    // 変わるたびに 1 行ずつ増える。全体を書き直していれば、行数は登録数と同じになる。
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.length).toBe(22);
    expect(store.count()).toBe(21);
    // 最後の 1 行が、いちばん新しい版である。
    expect(JSON.parse(lines[lines.length - 1] ?? "{}").displayName).toBe("なまえ");
  });

  it("古い版が溜まったら書き直して捨てる", () => {
    const { store, dir } = newStore();
    const path = join(dir, "accounts.jsonl");
    const { secret } = store.create("あ", 0);
    for (let i = 0; i < 200; i++) store.touch(secret, i);

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.length).toBeLessThan(200);
    // 書き直したあとも、読み直せば最新の 1 版が残っている。
    expect(new AccountStore(dir).bySecret(secret)?.displayName).toBe("あ");
  });

  it("全体を 1 つの配列で持っていたファイルも読める", () => {
    const { store, dir } = newStore();
    const { account, secret } = store.create("むかし", 0);
    const rows = JSON.parse(readFileSync(join(dir, "accounts.jsonl"), "utf8").trimEnd());
    rmSync(join(dir, "accounts.jsonl"));
    writeFileSync(join(dir, "accounts.json"), `${JSON.stringify([rows], null, 2)}\n`, "utf8");

    const reloaded = new AccountStore(dir);

    expect(reloaded.bySecret(secret)?.playerId).toBe(account.playerId);
    // 読み込みのときに新しい形へ書き直す。次からは追記で済む。
    expect(existsSync(join(dir, "accounts.jsonl"))).toBe(true);
  });

  it("読めない行が混じっても、読めるアカウントは読める", () => {
    const { store, dir } = newStore();
    const path = join(dir, "accounts.jsonl");
    const { secret } = store.create("あ", 0);
    appendFileSync(path, "{壊れている\n");
    store.create("い", 0);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reloaded = new AccountStore(dir);
      expect(reloaded.count()).toBe(2);
      expect(reloaded.bySecret(secret)?.displayName).toBe("あ");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * **読み飛ばすだけでは足りない。** 途中で落ちた追記は、改行の無い半端な行を末尾に残す。
   * そこへ次の 1 行を足すと 2 つが 1 行に繋がり、どちらも読めなくなる。飛ばした側だけでなく
   * **そのとき作ったアカウントも消える。** サーバはシークレットを持たないので、戻せない。
   */
  it("途中で切れた行が残っていても、次に作ったアカウントを失わない", () => {
    const { store, dir } = newStore();
    const path = join(dir, "accounts.jsonl");
    const { secret } = store.create("あ", 0);
    // 追記の途中で落ちた状態。最後の行に改行が無い。
    appendFileSync(path, '{"playerId":"とちゅう","displayName":"い', "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reopened = new AccountStore(dir);
      const added = reopened.create("う", 0);

      const again = new AccountStore(dir);
      expect(again.bySecret(secret)?.displayName).toBe("あ");
      expect(again.bySecret(added.secret)?.displayName).toBe("う");
      expect(again.count()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  /** 上と同じことが、JSON として読めない行が混じったときにも起きる。 */
  it("読めない行のあとに足したアカウントも、次に開いたとき残っている", () => {
    const { store, dir } = newStore();
    const path = join(dir, "accounts.jsonl");
    store.create("あ", 0);
    appendFileSync(path, "{壊れている\n", "utf8");

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reopened = new AccountStore(dir);
      const added = reopened.create("い", 0);
      // 読み直したときに詰め直してあるので、読めない行はもう残っていない。
      expect(readFileSync(path, "utf8")).not.toContain("壊れている");
      expect(new AccountStore(dir).bySecret(added.secret)?.displayName).toBe("い");
    } finally {
      warn.mockRestore();
    }
  });

  it("書いたものを読み直しても続く", () => {
    const { store, dir } = newStore();
    const { account, secret } = store.create("あ", 0);
    const other = store.create("い", 0);
    store.applyResult([account.playerId, other.account.playerId], 1, 0);

    const reloaded = new AccountStore(dir);
    expect(reloaded.count()).toBe(2);
    expect(reloaded.bySecret(secret)?.rating).toBe(INITIAL_RATING + K_FACTOR / 2);
  });
});

describe("レーティング", () => {
  function pair(): { store: AccountStore; a: string; b: string } {
    const { store } = newStore();
    return {
      store,
      a: store.create("あ", 0).account.playerId,
      b: store.create("い", 0).account.playerId,
    };
  }

  it("同じレーティングなら、勝った側と負けた側が同じ幅だけ動く", () => {
    const { store, a, b } = pair();
    const after = store.applyResult([a, b], 1, 0);

    expect(after).toEqual([INITIAL_RATING + K_FACTOR / 2, INITIAL_RATING - K_FACTOR / 2]);
    expect(store.byPlayerId(a)?.wins).toBe(1);
    expect(store.byPlayerId(b)?.losses).toBe(1);
  });

  it("同じレーティングどうしの引き分けでは動かない", () => {
    const { store, a, b } = pair();
    expect(store.applyResult([a, b], 0.5, 0)).toEqual([INITIAL_RATING, INITIAL_RATING]);
    expect(store.byPlayerId(a)?.draws).toBe(1);
  });

  // 番狂わせのほうが大きく動く。これが無いと、強い相手に勝っても弱い相手に勝っても同じになる。
  it("低いほうが勝つと、高いほうが勝つより大きく動く", () => {
    const { store, a, b } = pair();
    for (let i = 0; i < 5; i++) store.applyResult([a, b], 1, 0);
    const strong = store.byPlayerId(a)?.rating ?? 0;
    const weak = store.byPlayerId(b)?.rating ?? 0;
    expect(strong).toBeGreaterThan(weak);

    const upset = store.applyResult([b, a], 1, 0);
    const gainOfWeak = (upset?.[0] ?? 0) - weak;
    expect(gainOfWeak).toBeGreaterThan(K_FACTOR / 2);
  });

  it("知らないプレイヤーの結果は入れない", () => {
    const { store, a } = pair();
    expect(store.applyResult([a, "そんな人はいない"], 1, 0)).toBeNull();
    expect(store.byPlayerId(a)?.games).toBe(0);
  });
});

/**
 * シークレットを返すのはアカウントを作るこの 1 度だけで、サーバは控えを持たない。
 * 書けずに 500 を返したのにメモリだけ残ると、**誰にも名乗れないアカウント**ができる。
 * 消すエンドポイントは無く、次の詰め直しでそれがファイルにも載る。
 */
describe("作れなかったときの後始末", () => {
  it("書けなければ、覚えたぶんも残さない", () => {
    const dir = mkdtempSync(join(tmpdir(), "poke-acc-"));
    const store = new AccountStore(dir);
    const { secret } = store.create("さきに", 0);
    const before = store.count();

    // 保存先をファイルにしてしまえば、次の追記は必ず落ちる。
    rmSync(join(dir, "accounts.jsonl"));
    writeFileSync(dir + ".jsonl", "", "utf8");
    const blocked = new AccountStore(dir + ".jsonl");
    expect(() => blocked.create("書けない", 0)).toThrow();
    expect(blocked.count()).toBe(0);
    expect(blocked.bySecret("なんであれ")).toBeNull();

    // 先に作れていたものは触っていない。
    expect(store.count()).toBe(before);
    expect(store.bySecret(secret)).not.toBeNull();
  });
});
