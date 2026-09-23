/**
 * 画面の状態遷移。ここに集まっていた回帰を、そのまま 1 本ずつテストにしてある。
 *
 * **当てるのは要素の id と個数・状態だけで、文言では判定しない。** 画面の文字は
 * 仕様の対象外であり、書き換わっても壊れないテストにしておく必要がある。
 */

import { createHash } from "node:crypto";
import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

/**
 * 画面が投げっぱなしにした例外を集め、テストの終わりに 1 つも無いことを確かめる。
 *
 * **これが無いと、画面が毎回例外を投げていても 1 本も落ちない。** 例外は assert を
 * 通らないので、盤面さえ描けていれば緑のままになる（仕込んで確認した）。
 *
 * **`console` の error は見ない。** わざと 503 や 502 を返すテストが、そのたびに
 * ブラウザに「読み込めなかった」と書かせる。それを落ちる条件にすると、仕掛けた側の
 * テストが自分の仕掛けで落ちる。ここで見たいのは、握られずに飛んだ例外だけである。
 */
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({}, use) => {
    const errors: string[] = [];
    await use(errors);
    expect(errors).toEqual([]);
  },
  page: async ({ page, pageErrors }, use) => {
    watch(page, pageErrors);
    await use(page);
  },
});

function watch(page: Page, errors: string[]): Page {
  page.on("pageerror", (error) => errors.push(error.message));
  return page;
}

/**
 * 別々のアカウントで見る 2 枚のページと、その後片付け。
 *
 * ページを作るのはここだけにしてある。`browser.newPage()` を直に呼ぶと、そのページで
 * 飛んだ例外を誰も見ないまま増える。
 */
async function openPair(
  browser: Browser,
  errors: string[],
): Promise<[Page, Page, () => Promise<void>]> {
  const contexts: [BrowserContext, BrowserContext] = [
    await browser.newContext(),
    await browser.newContext(),
  ];
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  const close = async (): Promise<void> => {
    await Promise.all(contexts.map((context) => context.close()));
  };
  return [watch(a as Page, errors), watch(b as Page, errors), close];
}

/** アカウントは localStorage ごとに別なので、テストごとに新しい文脈を使えば混ざらない。 */
test.describe.configure({ mode: "parallel" });

/** 対戦に入る。デッキを空のままにするとサンプルデッキが使われる。 */
async function join(page: Page, room: string): Promise<void> {
  await page.fill("#room", room);
  await page.click("#join-button");
}

/**
 * 手番が来ている側の、いちばん上の手を指す。指せなければ false。
 *
 * **数えてから押す、の 2 段にしない。** 相手の手が届くたびに `#moves` は作り直されるので、
 * 数えた時点で並んでいた手が、押す時点では消えている。押してみて駄目なら相手の番である。
 */
async function playOne(page: Page): Promise<boolean> {
  try {
    await page.locator("#moves button").first().click({ timeout: 1_000 });
    return true;
  } catch {
    return false;
  }
}

test("読み込みと「対戦をさがす」が重なっても、アカウントは 1 つしかできない", async ({ page }) => {
  const created: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/account")) {
      created.push(request.url());
    }
  });

  /**
   * **1 本目が走っている最中に押す。** 返事を止めておかないと、画面を開いた時点の
   * 読み込みが押す前に終わってしまい、競合そのものが起きない。返事が返れば
   * シークレットが残るので、2 本目は作りに行かず引き直しに回る。
   */
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/account", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/");
  await page.click("#join-button");
  release();

  await expect(page.locator("#account")).not.toBeEmpty();
  await expect(page.locator("#join-status")).not.toBeEmpty();

  // 待ち合わせていないと 2 つできて、画面のレーティングと実際に指すアカウントが食い違う。
  expect(created).toHaveLength(1);
});

test("読み込みの返事が遅れても、打ち込んだ名前を書き戻さない", async ({ page }) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/account", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto("/");
  // 返事が来る前に打つ。ここで書き戻されると、打った名前が消えたまま送られる。
  await page.fill("#name", "ぼくのなまえ");
  release();

  await expect(page.locator("#account")).not.toBeEmpty();
  await expect(page.locator("#name")).toHaveValue("ぼくのなまえ");
});

test("同じルームコードの 2 人が繋がり、手番側にだけ手が並ぶ", async ({ browser, pageErrors }) => {
  const room = `あいことば-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  // 先に入ったほうはチケットを持って待つ。2 人目が入った時点で席が決まる。
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  await expect(a.locator("#table")).toBeVisible();
  await expect(b.locator("#table")).toBeVisible();

  /**
   * **手が並ぶのは片側だけである。** サーバは手番でない座席へ `legalMoves` を送らない。
   * 両方に並ぶなら、射影ではなく生の局面が流れている。
   */
  const counts = await Promise.all([
    a.locator("#moves button").count(),
    b.locator("#moves button").count(),
  ]);
  expect(counts.filter((count) => count > 0)).toHaveLength(1);

  await close();
});

/**
 * 1 局を 12 手だけ指して投了し、その対戦の読み返しを開いたページを返す。
 * 読み返しの試験はどれもここから始まるので、足場にしてある。
 */
async function replayOfFinishedMatch(
  browser: Browser,
  errors: string[],
  room: string,
): Promise<[Page, () => Promise<void>]> {
  const [a, b, close] = await openPair(browser, errors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();
  await expect(b.locator("#table")).toBeVisible();

  // 読み返せる手数を作る。どちらが手番かは入れ替わるので、両方に聞く。
  const WANTED = 12;
  let played = 0;
  for (let attempt = 0; attempt < 60 && played < WANTED; attempt += 1) {
    if (await playOne(a)) played += 1;
    else if (await playOne(b)) played += 1;
  }
  expect(played).toBe(WANTED);

  /**
   * 投了で終わらせる。指した手はログに残るので、そこまでは辿れる。決着を受け取った印は
   * レーティングの引き直しなので、その往復を待つ。画面の文言では判定しない。
   */
  const settled = a.waitForResponse((response) => response.url().endsWith("/api/account/me"));
  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");
  await settled;

  await a.click("#history-button");
  /**
   * **最初の 1 枚が描けるまで待ってから返す。**
   *
   * `#replay` が見えるのは最初のフレームを取りに行く**前**なので、見えたことだけを
   * 待って返すと、そのあとテストが差し込む細工が初回フレームに当たることがある。
   * 初回フレームが落ちると読み返しは閉じ、以降の「1 手 ▶」は押せないまま固まる。
   */
  const firstFrame = a.waitForResponse((response) => response.url().endsWith("/api/replay"));
  await a.locator("#history-list button").first().click();
  await firstFrame;
  await expect(a.locator("#replay")).toBeVisible();
  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])0 \//);

  return [a, close];
}

test("読み返しで「1 手 ▶」を続けて押したぶんだけ進む", async ({ browser, pageErrors }) => {
  test.slow(); // 1 局ぶん指してから読み返すので、ほかより時間が要る。
  const [a, close] = await replayOfFinishedMatch(browser, pageErrors, `よみかえし-${Date.now()}`);

  /**
   * **押したぶんだけ進む。**
   *
   * 返事を遅らせてから続けて押す。**遅らせないと追い越しが起きない**ので、
   * 描けた手数から数えていても通ってしまう。描けた手数から数えていたときは、
   * 6 回ぶんがすべて同じ 1 手への問い合わせになり、6 回押しても 1 手しか進まなかった。
   */
  await a.route("**/api/replay", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });

  const next = a.locator("#replay-next");
  for (let i = 0; i < 6; i += 1) await next.click({ noWaitAfter: true });

  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])6 \//);

  await close();
});

test("1 度取りに行けなかっただけで、次に押したぶんが飛ばない", async ({ browser, pageErrors }) => {
  test.slow();
  const [a, close] = await replayOfFinishedMatch(browser, pageErrors, `しくじり-${Date.now()}`);

  // 1 手目だけ落とす。行き先を戻していないと、次に押したぶんが 2 手目へ飛ぶ。
  let failed = false;
  await a.route("**/api/replay", async (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 503, body: "{}" });
  });

  const next = a.locator("#replay-next");
  await next.click();
  await expect(a.locator("#replay-status")).not.toBeEmpty();
  await next.click();

  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])1 \//);

  await close();
});

test("追い越して届いた古い局面では描き直さない", async ({ browser, pageErrors }) => {
  test.slow();
  const [a, close] = await replayOfFinishedMatch(browser, pageErrors, `おいこし-${Date.now()}`);

  /**
   * **先に出したものほど遅く返す。** 続けて押したり別の対戦へ移ったりすると、
   * 出した順と返る順が入れ替わる。あとから来た古い盤面で上書きすると、
   * 手数の表示と盤面がずれたまま残る。
   */
  await a.route("**/api/replay", async (route) => {
    const { ply } = route.request().postDataJSON() as { ply: number };
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 900 - ply * 140)));
    await route.continue();
  });

  const next = a.locator("#replay-next");
  for (let i = 0; i < 6; i += 1) await next.click({ noWaitAfter: true });

  // 最後に出した 6 手目で落ち着く。遅れて届く 1 手目が勝ってはいけない。
  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])6 \//);
  await a.waitForTimeout(600); // 遅い返事が全部届くまで見届ける。
  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])6 \//);

  await close();
});

/**
 * 切断からの繋ぎ直し（仕様 3.3 節）。
 *
 * サーバ側の繋ぎ直しは座席トークンだけで済むが、**それを画面が持っていなければ使えない。**
 * 切断中も時計は流れる（3.4 節）ので、戻れないことはそのまま時間切れ負けになる。
 */
test("読み込み直しても、指していた座席へ戻る", async ({ browser, pageErrors }) => {
  const room = `もどる-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();
  await expect(b.locator("#table")).toBeVisible();

  await a.reload();

  // 盤面が描けたことまで見る。`#table` が出るのは繋ぐ前なので、見えただけでは座席に就けていない。
  await expect(a.locator("#join")).toBeHidden();
  await expect(a.locator("#table")).toBeVisible();
  await expect(a.locator("#clock")).not.toBeEmpty();

  /**
   * **戻った座席から指せることまで見る。** 盤面はサーバが送ってくるので、描けただけなら
   * 読むだけの繋ぎ直しでも通る。手が通るのは、サーバがこの接続を元の座席と認めたときだけである。
   */
  let played = false;
  for (let attempt = 0; attempt < 6 && !played; attempt += 1) {
    played = (await playOne(a)) || (await playOne(b));
  }
  expect(played).toBe(true);

  await close();
});

/**
 * 覚えている座席が通らなかったときに、マッチングの画面へ戻すこと。
 *
 * 戻さないと、開くたびに同じ座席へ繋ぎに行って同じ形で閉じる。**対戦を始める画面が
 * 二度と出ない**ので、その人はこのブラウザで指せなくなる。
 */
test("サーバが知らない座席を覚えていたら、マッチングの画面へ戻す", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "もう無い座席" })),
  );
  await page.reload();

  await expect(page.locator("#join")).toBeVisible();
  await expect(page.locator("#table")).toBeHidden();
  await expect(page.locator("#join-status")).not.toBeEmpty();
  // 覚えたままだと、次に開いたときも同じ形で閉じる。
  expect(await page.evaluate(() => localStorage.getItem("poke-seat"))).toBeNull();
});

/**
 * 繋がらなかっただけでは、覚えている座席を捨てないこと。
 *
 * Upgrade を通さない中継を挟むと、繋ぐ段階で断られ、何も受け取らずに閉じる。
 * これを「サーバが座席を知らない」と読んで捨てると、続いている対戦へ戻れず時間切れで負ける。
 */
test("繋がらずに閉じただけなら、座席を覚えたままマッチングの画面を出す", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つづいている座席" })),
  );
  // 何も届かないまま閉じる形を作る。
  await page.routeWebSocket(/\/ws\?/, (ws) => ws.close());
  await page.reload();

  // 開いた直後は盤面の画面が出るので、閉じたあとにしか起きないことを待ってから見る。
  await expect(page.locator("#join")).toBeVisible();
  await expect(page.locator("#table")).toBeHidden();
  await expect(page.locator("#join-status")).not.toBeEmpty();
  expect(await page.evaluate(() => localStorage.getItem("poke-seat"))).not.toBeNull();
});

/**
 * 終わった座席を捨てるときに、別のタブが置いた新しい座席まで消さないこと。
 * 座席はタブをまたいで同じ localStorage に置くので、消すと新しい対戦へ戻れなくなる。
 */
test("終わった座席を捨てても、別のタブが置いた座席は残す", async ({ browser, pageErrors }) => {
  const context = await browser.newContext();
  const stale = watch(await context.newPage(), pageErrors);
  const fresh = watch(await context.newPage(), pageErrors);
  const next = JSON.stringify({ seat: 1, seatToken: "あたらしい座席" });
  await Promise.all([stale.goto("/"), fresh.goto("/")]);
  await stale.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "おわった座席" })),
  );
  // 古いタブが断られる前に、別のタブが新しい座席を置く。
  await stale.routeWebSocket(/\/ws\?/, async (ws) => {
    await fresh.evaluate((seat) => localStorage.setItem("poke-seat", seat), next);
    ws.send(JSON.stringify({ t: "error", message: "座席が見つからない", code: "seat-not-found" }));
    ws.close();
  });
  await stale.reload();

  await expect(stale.locator("#join")).toBeVisible();
  expect(await stale.evaluate(() => localStorage.getItem("poke-seat"))).toBe(next);

  await context.close();
});

/**
 * 終わった対戦の座席を覚えたままにしないこと。
 *
 * 覚えたままでも、次に開いたときは上の歯止めが働いてマッチングの画面へ戻る。
 * ただしそこまで往復が 1 つ増え、そのあいだ「もう終わっている」と言えない。
 */
test("対戦が終わったら、座席を覚えておかない", async ({ browser, pageErrors }) => {
  const room = `おわる-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();

  // 決着を受け取った印はレーティングの引き直しである。画面の文言では判定しない。
  const settled = a.waitForResponse((response) => response.url().endsWith("/api/account/me"));
  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");
  await settled;

  expect(await a.evaluate(() => localStorage.getItem("poke-seat"))).toBeNull();

  await close();
});

/**
 * 観戦（仕様 3.6 節）。座席に渡った観戦のリンクを、3 人目が開く。
 *
 * **リンクを開いただけの人にプレイヤーを作らない。** プレイヤーを消す道は無いので、
 * 観戦のたびに 1 人ずつ残り続ける。
 */
test("観戦のリンクを開くと、プレイヤーを作らずに両者の盤面が映り、手が進むと描き直す", async ({
  browser,
  pageErrors,
}) => {
  const room = `かんせん-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();
  await expect(a.locator("#watch-link")).not.toHaveValue("");
  const link = await a.locator("#watch-link").inputValue();

  const context = await browser.newContext();
  const watcher = watch(await context.newPage(), pageErrors);
  const created: string[] = [];
  watcher.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/account")) {
      created.push(request.url());
    }
  });
  await watcher.goto(link);

  await expect(watcher.locator("#watch")).toBeVisible();
  await expect(watcher.locator("#join")).toBeHidden();
  await expect(watcher.locator("#table")).toBeHidden();
  await expect(watcher.locator("#watch-side-0")).not.toBeEmpty();
  await expect(watcher.locator("#watch-side-1")).not.toBeEmpty();
  await expect(watcher.locator("#watch-events li")).toHaveCount(0);

  let played = false;
  for (let attempt = 0; attempt < 6 && !played; attempt += 1) {
    played = (await playOne(a)) || (await playOne(b));
  }
  expect(played).toBe(true);
  // 座席の 1 手が観戦者へも届いた印は、できごとの行が増えることである。
  await expect(watcher.locator("#watch-events li")).not.toHaveCount(0);

  expect(created).toEqual([]);
  await context.close();
  await close();
});

test("観戦のリンクが通らなければ、そう出して終わる", async ({ page }) => {
  await page.goto("/?watch=もう無い対戦");
  await expect(page.locator("#watch")).toBeVisible();
  await expect(page.locator("#watch-status")).not.toBeEmpty();
});

/**
 * シャッフルの検算（仕様 6.4 節）。決着で開かれた値を、席に着く前に受け取ったコミットと
 * 突き合わせる。検算が合うことと、サーバが値を差し替えたら合わないと出すことの両方を見る。
 * 片方だけだと、何を渡されても「合う」と出す画面でも通ってしまう。
 */
test("決着のあと、両座席がシャッフルを検算して合う", async ({ browser, pageErrors }) => {
  const room = `けんざん-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#self .row").first()).toBeVisible();

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");

  await expect(a.locator("#shuffle-check")).toHaveAttribute("data-result", "ok");
  await expect(b.locator("#shuffle-check")).toHaveAttribute("data-result", "ok");

  await close();
});

test("決着で開かれたシェアが差し替えられていたら、合わないと出す", async ({
  browser,
  pageErrors,
}) => {
  const room = `さしかえ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  // b に届く決着だけ、両座席のシェアを入れ替える。サーバが並びを選び直したのと同じ形になる。
  await b.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "ended") message.seedShares = [...message.seedShares].reverse();
      client.send(JSON.stringify(message));
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#self .row").first()).toBeVisible();

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");

  await expect(a.locator("#shuffle-check")).toHaveAttribute("data-result", "ok");
  await expect(b.locator("#shuffle-check")).toHaveAttribute("data-result", "mismatch");

  await close();
});

/**
 * 相手のシェアを待っているあいだに接続が切れても、席を忘れない。`sync` が届く前に切れたことだけで
 * 「サーバが座席を知らない」と読むと、始まる直前の対戦から降り、座らないまま時間切れで負ける。
 */
test("相手のシェアを待っているあいだに切れても、席を覚えている", async ({
  browser,
  pageErrors,
}) => {
  const room = `まちぼうけ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  // b は席を取っても繋がない。対戦はシェアがそろうのを待ったままになる。
  await b.routeWebSocket(/\/ws\?/, (client) => client.close());
  // a の接続は、`pending` を受け取ったところで切る。
  let pendingSeen = false;
  await a.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      client.send(raw);
      if (JSON.parse(String(raw)).t === "pending") {
        pendingSeen = true;
        client.close();
      }
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  await expect.poll(() => pendingSeen).toBe(true);
  await expect(a.locator("#table")).toBeVisible();
  expect(await a.evaluate(() => localStorage.getItem("poke-seat"))).not.toBeNull();

  await close();
});

/**
 * サーバが自分のシェアのコミットをすり替え、自分のシェアとして別の値を開いた形。
 * コミットとシェアの組は辻褄が合っているので、送ったコミットと見比べないと「シェアが使われていない」
 * としか出せず、すり替えだと分からない。
 */
test("自分のシェアのコミットがすり替えられていたら、合わないと出す", async ({
  browser,
  pageErrors,
}) => {
  const room = `すりかえ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const forged = "c".repeat(64);
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  // b は 2 人目なので、席は参加の応答で届く。
  await b.route("**/api/join", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.seat !== undefined) body.seat.seedShareCommits[1] = sha256(`share:${forged}`);
    await route.fulfill({ response, json: body });
  });
  await b.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "ended") {
        message.seedShares[1] = forged;
        message.seed = sha256(
          `seed:${message.seedNonce}:${message.seedShares[0] ?? ""}:${forged}`,
        ).slice(0, 32);
      }
      client.send(JSON.stringify(message));
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#self .row").first()).toBeVisible();

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");

  await expect(b.locator("#shuffle-check")).toHaveAttribute("data-result", "mismatch");

  await close();
});

/**
 * 相手のシェアが期限に遅れたとされた形。サーバは届いたシェアを捨てるかどうかで並びを
 * 2 通りから選べるので、値の対応が合っていても、黙って「合う」とだけは出さない。
 */
test("相手のシェアが使われていなければ、そう出す", async ({ browser, pageErrors }) => {
  const room = `おくれ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  // a（座席 0）に届く決着だけ、相手のシェアを null にして seed を作り直す。
  await a.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.t === "ended") {
        message.seedShares[1] = null;
        message.seed = sha256(`seed:${message.seedNonce}:${message.seedShares[0] ?? ""}:`).slice(
          0,
          32,
        );
      }
      client.send(JSON.stringify(message));
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#self .row").first()).toBeVisible();

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");

  await expect(a.locator("#shuffle-check")).toHaveAttribute("data-result", "opponent-share-unused");
  await expect(b.locator("#shuffle-check")).toHaveAttribute("data-result", "ok");

  await close();
});
