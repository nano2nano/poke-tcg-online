/**
 * 画面の状態遷移。ここに集まっていた回帰を、そのまま 1 本ずつテストにしてある。
 *
 * **当てるのは要素の id と個数・状態だけで、文言では判定しない。** 画面の文字は
 * 仕様の対象外であり、書き換わっても壊れないテストにしておく必要がある。
 */

import { expect, test, type Browser, type Page } from "@playwright/test";

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

test("同じルームコードの 2 人が繋がり、手番側にだけ手が並ぶ", async ({ browser }) => {
  const room = `あいことば-${Date.now()}`;
  const [first, second] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([first.newPage(), second.newPage()]);

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

  await Promise.all([first.close(), second.close()]);
});

/**
 * 1 局を 12 手だけ指して投了し、その対戦の読み返しを開いたページを返す。
 * 読み返しの試験はどれもここから始まるので、足場にしてある。
 */
async function replayOfFinishedMatch(
  browser: Browser,
  room: string,
): Promise<[Page, () => Promise<void>]> {
  const [first, second] = await Promise.all([browser.newContext(), browser.newContext()]);
  const [a, b] = await Promise.all([first.newPage(), second.newPage()]);

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
  await a.locator("#history-list button").first().click();
  await expect(a.locator("#replay")).toBeVisible();

  return [a, async () => void (await Promise.all([first.close(), second.close()]))];
}

test("読み返しで「1 手 ▶」を続けて押したぶんだけ進む", async ({ browser }) => {
  test.slow(); // 1 局ぶん指してから読み返すので、ほかより時間が要る。
  const [a, close] = await replayOfFinishedMatch(browser, `よみかえし-${Date.now()}`);

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

test("1 度取りに行けなかっただけで、次に押したぶんが飛ばない", async ({ browser }) => {
  test.slow();
  const [a, close] = await replayOfFinishedMatch(browser, `しくじり-${Date.now()}`);

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

test("追い越して届いた古い局面では描き直さない", async ({ browser }) => {
  test.slow();
  const [a, close] = await replayOfFinishedMatch(browser, `おいこし-${Date.now()}`);

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
