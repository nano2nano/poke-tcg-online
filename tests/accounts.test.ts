/**
 * 打ち手と持ち点（`docs/spec/battle-server.md` 7.2 節）。
 *
 * 持ち点は体験のためではなく記録のためにある。座席と人をあとから結び直すことは
 * できないので、ここが壊れていると、集めた対局から打ち手の強さが永久に失われる。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore, INITIAL_RATING, K_FACTOR } from "../src/accounts.js";

function newStore(): { store: AccountStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "poke-accounts-"));
  return { store: new AccountStore(dir), dir };
}

describe("打ち手", () => {
  it("作った打ち手を合言葉で引ける", () => {
    const { store } = newStore();
    const { account, secret } = store.create("あ", 0);

    expect(account.rating).toBe(INITIAL_RATING);
    expect(account.games).toBe(0);
    expect(store.bySecret(secret)?.playerId).toBe(account.playerId);
    expect(store.bySecret("ちがう合言葉")).toBeNull();
  });

  // 合言葉が保存されていると、置き場が漏れただけで他人の対戦に入れる。
  it("合言葉そのものを保存しない", () => {
    const { store, dir } = newStore();
    const { secret } = store.create("あ", 0);

    const saved = readFileSync(join(dir, "accounts.json"), "utf8");
    expect(saved).not.toContain(secret);
  });

  // 識別子は対局ログに残る。合言葉と同じ値だと、ログが合言葉の一覧になる。
  it("公開の識別子と合言葉を別の値にする", () => {
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
   * 2 つ組の文字が半分になったものが、そのまま置き場にも記録にも入る。
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
    // 見えない字だけの名前は、名乗っていないのと同じである。
    expect(name("\u202e\u200b\u00ad")).toBe("ななし");

    // ZWJ は絵文字を 1 つに繋ぐ。落とすと 3 人が並んだ別の字になる。
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(name(family)).toBe(family);
    // 繋ぐ相手のいない端の繋ぎ字は、それだけでは字にならない。
    expect(name("\u200dあい\u200d")).toBe("あい");
  });

  it("名乗り直しても持ち点と戦績は動かない", () => {
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

describe("持ち点", () => {
  function pair(): { store: AccountStore; a: string; b: string } {
    const { store } = newStore();
    return {
      store,
      a: store.create("あ", 0).account.playerId,
      b: store.create("い", 0).account.playerId,
    };
  }

  it("同じ持ち点なら、勝った側と負けた側が同じ幅だけ動く", () => {
    const { store, a, b } = pair();
    const after = store.applyResult([a, b], 1, 0);

    expect(after).toEqual([INITIAL_RATING + K_FACTOR / 2, INITIAL_RATING - K_FACTOR / 2]);
    expect(store.byPlayerId(a)?.wins).toBe(1);
    expect(store.byPlayerId(b)?.losses).toBe(1);
  });

  it("同じ持ち点どうしの引き分けでは動かない", () => {
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

  it("知らない打ち手の結果は入れない", () => {
    const { store, a } = pair();
    expect(store.applyResult([a, "そんな人はいない"], 1, 0)).toBeNull();
    expect(store.byPlayerId(a)?.games).toBe(0);
  });
});
