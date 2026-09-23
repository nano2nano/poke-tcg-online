/**
 * プレイヤーとレーティング（`docs/spec/battle-server.md` 7.2 節）。
 *
 * レーティングは体験のためではなく記録のためにある。座席と人をあとから結び直すことは
 * できないので、ここが壊れていると、集めた対局からプレイヤーの強さが永久に失われる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { AccountStore, INITIAL_RATING, K_FACTOR } from "../src/accounts.js";
import { startStorage } from "./worker.js";

let storage: Awaited<ReturnType<typeof startStorage>>;
let db: D1Database;

beforeAll(async () => {
  storage = await startStorage();
  db = storage.db;
});

afterAll(async () => {
  await storage.close();
});

function newStore(capacity?: number): AccountStore {
  return new AccountStore(db, capacity);
}

describe("プレイヤー", () => {
  it("作ったプレイヤーをシークレットで引ける", async () => {
    const store = newStore();
    const { account, secret } = await store.create("あ", 0);

    expect(account.rating).toBe(INITIAL_RATING);
    expect(account.games).toBe(0);
    expect((await store.find(secret))?.playerId).toBe(account.playerId);
    expect(await store.find("ちがうシークレット")).toBeNull();
  });

  // シークレットが保存されていると、D1 の中身が漏れただけで他人の対戦に入れる。
  it("シークレットそのものを保存しない", async () => {
    const store = newStore();
    const { account, secret } = await store.create("あ", 0);

    const row = await db
      .prepare("SELECT * FROM players WHERE player_id = ?")
      .bind(account.playerId)
      .first();
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  // 識別子は対局ログに残る。シークレットと同じ値だと、ログがシークレットの一覧になる。
  it("公開の識別子とシークレットを別の値にする", async () => {
    const { account, secret } = await newStore().create("あ", 0);
    expect(account.playerId).not.toBe(secret);
  });

  it("制御文字を落とし、名無しには既定の名を当てる", async () => {
    const store = newStore();
    expect((await store.create("あ\u0000い\nう", 0)).account.displayName).toBe("あいう");
    expect((await store.create("   ", 0)).account.displayName).toBe("ななし");
    expect((await store.create("あ".repeat(100), 0)).account.displayName.length).toBe(40);
  });

  /**
   * 表示名は画面と対局ログの両方へ出る。UTF-16 の長さで切ると、絵文字のような
   * 2 つ組の文字が半分になったものが、そのままストアにも記録にも入る。
   */
  it("長い名前を切るとき、文字を割らない", async () => {
    const store = newStore();
    // どれも 1 文字で、UTF-16 では 2 つぶんの長さを持つ。
    const long = "🎴".repeat(100);
    const name = (await store.create(long, 0)).account.displayName;

    expect([...name]).toHaveLength(40);
    expect(name).toBe("🎴".repeat(40));
    // 半端な片割れが残っていない。残っていれば往復で形が変わる。
    expect(JSON.parse(JSON.stringify(name))).toBe(name);
    expect(name).not.toContain("\uFFFD");
    expect([...name].every((char) => char === "🎴")).toBe(true);

    // 2 つ組と普通の文字が混じっていても、数えるのは文字のほうである。
    const mixed = (await store.create(`${"🎴".repeat(39)}あいう`, 0)).account.displayName;
    expect([...mixed]).toHaveLength(40);
    expect(mixed.endsWith("あ")).toBe(true);
  });

  /**
   * 表示名は一覧にも対局ログにも出る。見えない字を通すと、並んだ名前が
   * 読み手の目に別のものとして映る。
   */
  it("見えない字を落とし、字を繋ぐものは残す", async () => {
    const store = newStore();
    const name = async (raw: string) => (await store.create(raw, 0)).account.displayName;

    // どれも 0x20 より上にあるが、画面には出ない。
    expect(await name("あ\u007fい\u0085う\u009f")).toBe("あいう");
    expect(await name("あ\ufeffい")).toBe("あい");
    // 向きを変える字。残すと、一覧に並んだ名前がうしろから読める形で出る。
    expect(await name("あいう\u202e")).toBe("あいう");
    expect(await name("\u202eあいう")).toBe("あいう");
    // 相方を失った片割れは、書き出すときに別の値へ化ける。
    expect(await name("あ\ud800い")).toBe("あい");
    // 見えない字だけの名前は、何も付けていないのと同じである。
    expect(await name("\u202e\u200b\u00ad")).toBe("ななし");

    // ZWJ は絵文字を 1 つに繋ぐ。落とすと 3 人が並んだ別の字になる。
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(await name(family)).toBe(family);
    // 繋ぐ相手のいない端の繋ぎ字は、それだけでは字にならない。
    expect(await name("\u200dあい\u200d")).toBe("あい");
  });

  it("表示名を変えてもレーティングと戦績は動かない", async () => {
    const store = newStore();
    const { account, secret } = await store.create("まえ", 0);
    const other = await store.create("あいて", 0);
    await store.applyResult([account.playerId, other.account.playerId], 1, 0);
    const won = await store.find(secret);

    const renamed = store.rename(won!, "あと", 1);
    expect(renamed.displayName).toBe("あと");
    expect(renamed.rating).toBe(won?.rating);
    expect(renamed.games).toBe(1);
    // 別のストアから D1 を読み直しても同じである。
    await store.settled();
    const reread = await newStore().find(secret);
    expect(reread?.displayName).toBe("あと");
    expect(reread?.rating).toBe(won?.rating);
  });

  it("書いたものを読み直しても続く", async () => {
    const store = newStore();
    // 2 つ組の文字と、字を繋ぐ ZWJ を含む名前。書き出しで化けると読み直したときに変わる。
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const { account, secret } = await store.create(family, 0);
    const other = await store.create("い", 0);
    await store.applyResult([account.playerId, other.account.playerId], 1, 0);

    const reloaded = await newStore().find(secret);
    expect(reloaded?.displayName).toBe(family);
    expect(reloaded?.rating).toBe(INITIAL_RATING + K_FACTOR / 2);
    expect(reloaded?.wins).toBe(1);
  });
});

/**
 * メモリに置くのは一部で、溢れたぶんは D1 から読み直す。書き換えるのはこのストアだけなので、
 * 読み直した版が古ければ、それはこちらの書き込みを追い越したということである。
 */
describe("メモリから捨てたプレイヤー", () => {
  it("捨てたあとも、最新のレーティングで読み直す", async () => {
    const store = newStore(1);
    const a = await store.create("あ", 0);
    const b = await store.create("い", 0);
    await store.applyResult([a.account.playerId, b.account.playerId], 1, 0);
    // 1 人しか置けないので、どちらかは捨てられている。
    expect(
      [a, b].filter(({ account }) => store.byPlayerId(account.playerId) === null),
    ).toHaveLength(1);

    expect((await store.find(a.secret))?.rating).toBe(INITIAL_RATING + K_FACTOR / 2);
    expect((await store.find(b.secret))?.rating).toBe(INITIAL_RATING - K_FACTOR / 2);
  });

  /**
   * 書き込みが列に溜まっているときに読み直すと、読むほうが先に D1 へ届きうる。
   * 読み直しも同じ列に並ばせていないと、直前に変えた名前が戻って見える。
   */
  it("読み直しが、先に出した書き込みを追い越さない", async () => {
    const store = newStore(1);
    const a = await store.create("まえ", 0);
    const others = [];
    for (let i = 0; i < 20; i++) others.push(await store.create(`ほか${i}`, 0));
    // 列を詰まらせる。どれもメモリに無いプレイヤーなので、D1 へ書くだけになる。
    for (const other of others) store.touch(other.account, 1);
    store.rename(a.account, "あと", 2);

    expect((await store.find(a.secret))?.displayName).toBe("あと");
  });

  /**
   * 同じプレイヤーを 2 つの要求が同時に読み直すと、あとから届いた古い版がメモリの新しい版を
   * 上書きしうる。そうなると、名前を変えた直後の対戦に前の名前で座る。
   */
  it("読み直した版で、メモリにある新しい版を上書きしない", async () => {
    const created = await newStore().create("まえ", 0);
    const store = newStore();
    const first = store.find(created.secret);
    const second = store.find(created.secret);
    store.rename((await first)!, "あと", 1);
    await second;

    expect(store.byPlayerId(created.account.playerId)?.displayName).toBe("あと");
  });
});

describe("レーティング", () => {
  async function pair(): Promise<{ store: AccountStore; a: string; b: string }> {
    const store = newStore();
    return {
      store,
      a: (await store.create("あ", 0)).account.playerId,
      b: (await store.create("い", 0)).account.playerId,
    };
  }

  it("同じレーティングなら、勝った側と負けた側が同じ幅だけ動く", async () => {
    const { store, a, b } = await pair();
    const after = await store.applyResult([a, b], 1, 0);

    expect(after).toEqual([INITIAL_RATING + K_FACTOR / 2, INITIAL_RATING - K_FACTOR / 2]);
    expect(store.byPlayerId(a)?.wins).toBe(1);
    expect(store.byPlayerId(b)?.losses).toBe(1);
  });

  it("同じレーティングどうしの引き分けでは動かない", async () => {
    const { store, a, b } = await pair();
    expect(await store.applyResult([a, b], 0.5, 0)).toEqual([INITIAL_RATING, INITIAL_RATING]);
    expect(store.byPlayerId(a)?.draws).toBe(1);
  });

  // 番狂わせのほうが大きく動く。これが無いと、強い相手に勝っても弱い相手に勝っても同じになる。
  it("低いほうが勝つと、高いほうが勝つより大きく動く", async () => {
    const { store, a, b } = await pair();
    for (let i = 0; i < 5; i++) await store.applyResult([a, b], 1, 0);
    const strong = store.byPlayerId(a)?.rating ?? 0;
    const weak = store.byPlayerId(b)?.rating ?? 0;
    expect(strong).toBeGreaterThan(weak);

    const upset = await store.applyResult([b, a], 1, 0);
    const gainOfWeak = (upset?.[0] ?? 0) - weak;
    expect(gainOfWeak).toBeGreaterThan(K_FACTOR / 2);
  });

  it("知らないプレイヤーの結果は入れない", async () => {
    const { store, a } = await pair();
    expect(await store.applyResult([a, "そんな人はいない"], 1, 0)).toBeNull();
    expect(store.byPlayerId(a)?.games).toBe(0);
  });

  /**
   * 一緒に書く文（対局ログの索引の行）が通らなければ、レーティングも動かさない。
   * 片方だけ残ると、索引に無い対戦でレーティングが動いている形になり、どこから来た差か言えない。
   */
  it("一緒に書く文が通らなければ、メモリでも D1 でも動かさない", async () => {
    const { store, a, b } = await pair();
    const broken = db.prepare("INSERT INTO そんな表は無い (x) VALUES (1)");
    await expect(store.applyResult([a, b], 1, 0, [broken])).rejects.toThrow();

    const row = await db
      .prepare("SELECT rating, games FROM players WHERE player_id = ?")
      .bind(a)
      .first<{ rating: number; games: number }>();
    expect(row).toEqual({ rating: INITIAL_RATING, games: 0 });
  });

  /**
   * D1 へは通ったのに、応答だけが落ちることがある。メモリに古いレーティングを残すと、
   * 次の対戦でその値から計算して書くので、D1 に入った 1 局ぶんが巻き戻る。
   */
  it("書けたか分からない失敗のあとは、D1 から読み直して計算する", async () => {
    let lost = false;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key !== "batch") return Reflect.get(target, key).bind(target);
        return async (statements: Parameters<D1Database["batch"]>[0]) => {
          const results = await target.batch(statements);
          if (!lost) {
            lost = true;
            throw new Error("応答が届かなかった");
          }
          return results;
        };
      },
    });
    const store = new AccountStore(flaky);
    const a = (await store.create("あ", 0)).account.playerId;
    const b = (await store.create("い", 0)).account.playerId;

    await expect(store.applyResult([a, b], 1, 0)).rejects.toThrow();
    const second = await store.applyResult([a, b], 1, 0);

    // 1 局目は D1 に入っている。2 局目はそこから積む。
    const first = INITIAL_RATING + K_FACTOR / 2;
    expect(second?.[0]).toBeGreaterThan(first);
    const row = await db
      .prepare("SELECT rating, games FROM players WHERE player_id = ?")
      .bind(a)
      .first<{ rating: number; games: number }>();
    expect(row).toEqual({ rating: second?.[0], games: 2 });
  });
});
