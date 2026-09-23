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
  type WebSocketRoute,
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
 * 1 局を 12 手だけ指して投了し、その対戦のリプレイを開いたページを返す。
 * リプレイのテストはどれもここから始めるので、1 つにまとめてある。
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
   * 初回フレームが落ちるとリプレイは閉じ、以降の「1 手 ▶」は押せないまま固まる。
   */
  const firstFrame = a.waitForResponse((response) => response.url().endsWith("/api/replay"));
  await a.locator("#history-list button").first().click();
  await firstFrame;
  await expect(a.locator("#replay")).toBeVisible();
  await expect(a.locator("#replay-status")).toContainText(/(^|[^0-9])0 \//);

  return [a, close];
}

test("リプレイで「1 手 ▶」を続けて押したぶんだけ進む", async ({ browser, pageErrors }) => {
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
 * 覚えたままでも、次に開いたときはサーバが座席を知らないと返すので、マッチングの画面へ戻る。
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

async function seatPair(a: Page, b: Page, room: string): Promise<void> {
  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#self .mat").first()).toBeVisible();
  await expect(b.locator("#self .mat").first()).toBeVisible();
}

async function playEither(a: Page, b: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await playOne(a)) || (await playOne(b))) return true;
  }
  return false;
}

/**
 * 繋ぎ直しの接続を止めておき、テストが開けたときに通す。止めないと、繋ぎ直しのあいだの
 * 画面は一瞬で過ぎて見られない。
 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * 切断中も時計は流れる（3.4 節）。読み込み直すまで戻れないと、気付かないうちに時間切れで負ける。
 */
test("対戦中に切れたら、読み込み直さずに同じ座席へ繋ぎ直す", async ({ browser, pageErrors }) => {
  const room = `つなぎなおす-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const held = gate();
  let opened = 0;
  // a の最初の接続は盤面が届いたところで切り、2 本目はテストが見終わるまで止める。
  await a.routeWebSocket(/\/ws\?/, async (client) => {
    opened += 1;
    const first = opened === 1;
    if (!first) await held.wait;
    const server = client.connectToServer();
    server.onMessage((raw) => {
      client.send(raw);
      if (first && JSON.parse(String(raw)).t === "sync") client.close();
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  await expect(a.locator("#connection")).toHaveAttribute("data-state", "reconnecting");
  await expect(a.locator("#concede-button")).toBeDisabled();
  await expect(a.locator("#table")).toBeVisible();
  expect(await a.evaluate(() => localStorage.getItem("poke-seat"))).not.toBeNull();

  held.open();
  await expect(a.locator("#connection")).toBeHidden();
  await expect(a.locator("#concede-button")).toBeEnabled();
  expect(opened).toBe(2);
  // 手が通るのは、サーバがこの接続を元の座席と認めたときだけである。
  expect(await playEither(a, b)).toBe(true);

  await close();
});

/** 切れているあいだに対戦が終わっていれば、サーバは座席を知らないと返す。そこで繋ぎ直すのをやめる。 */
test("繋ぎ直すあいだに対戦が終わっていたら、マッチングの画面へ戻す", async ({
  browser,
  pageErrors,
}) => {
  const room = `もうおわった-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const held = gate();
  let opened = 0;
  await a.routeWebSocket(/\/ws\?/, async (client) => {
    opened += 1;
    const first = opened === 1;
    if (!first) await held.wait;
    const server = client.connectToServer();
    server.onMessage((raw) => {
      client.send(raw);
      if (first && JSON.parse(String(raw)).t === "sync") client.close();
    });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#connection")).toHaveAttribute("data-state", "reconnecting");

  const settled = b.waitForResponse((response) => response.url().endsWith("/api/account/me"));
  b.once("dialog", (dialog) => void dialog.accept());
  await b.click("#concede-button");
  await settled;
  held.open();

  await expect(a.locator("#join")).toBeVisible();
  await expect(a.locator("#table")).toBeHidden();
  expect(await a.evaluate(() => localStorage.getItem("poke-seat"))).toBeNull();

  await close();
});

/**
 * 同じ座席に 2 本目が繋がると、サーバは古いほうを閉じる（3.3 節）。閉じられたタブが
 * 繋ぎ直すと今度は新しいほうが閉じられ、2 つのタブが互いを追い出し続ける。
 */
test("同じ座席を別のタブで開いたら、前のタブは繋ぎ直さない", async ({ browser, pageErrors }) => {
  const room = `ふたつめ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  let sockets = 0;
  a.on("websocket", () => {
    sockets += 1;
  });
  // サーバの合図だけで止まることを見るため、タブどうしの知らせ合いは使わせない。
  await a.addInitScript(() => Reflect.deleteProperty(globalThis, "BroadcastChannel"));
  await seatPair(a, b, room);

  // 同じブラウザの別のタブは localStorage を共有するので、開くと同じ座席へ繋ぐ。
  const other = watch(await a.context().newPage(), pageErrors);
  await other.goto("/");
  await expect(other.locator("#self .mat").first()).toBeVisible();

  await expect(a.locator("#connection")).toHaveAttribute("data-state", "replaced");
  // 繋ぎ直しの最初の間隔は 1 秒を超えない。それより長く待って、繋ぎに行かないことを見る。
  await a.waitForTimeout(2_500);
  expect(sockets).toBe(1);
  await expect(other.locator("#connection")).toBeHidden();
  expect(await playEither(other, b)).toBe(true);

  await close();
});

/** 前のタブが繋ぎ直すと、いま指しているタブの接続がサーバに閉じられる。 */
test("繋ぎ直しを待っているタブは、同じ座席を別のタブが開いたらやめる", async ({
  browser,
  pageErrors,
}) => {
  const room = `まちぶせ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  // a の 2 本目は放さない。サーバに届かないので、あとから開いたタブは閉じられない。
  const held = gate();
  let opened = 0;
  let first: WebSocketRoute | null = null;
  await a.routeWebSocket(/\/ws\?/, async (client) => {
    opened += 1;
    if (opened > 1) return held.wait;
    first = client;
    client.connectToServer();
  });
  await seatPair(a, b, room);
  (first as WebSocketRoute | null)?.close();
  await expect(a.locator("#connection")).toHaveAttribute("data-state", "reconnecting");

  const other = watch(await a.context().newPage(), pageErrors);
  await other.goto("/");
  await expect(other.locator("#self .mat").first()).toBeVisible();

  await expect(a.locator("#connection")).toHaveAttribute("data-state", "replaced");
  expect(await playEither(other, b)).toBe(true);

  await close();
});

/** 繋がらない状態が続くあいだ、間を空けずに繋ぎに行くと、サーバが戻った瞬間に全員が押し寄せる。 */
test("繋がらないあいだは、間隔を空けて繋ぎ直す", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つづいている座席" })),
  );
  let opened = 0;
  // 毎回、サーバが座席を知っている印を返してからすぐ切れる。繋がるたびに間隔を戻すと、
  // この形では 1 秒おきに繋ぎに行き続ける。
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    opened += 1;
    ws.send(JSON.stringify({ t: "pending" }));
    ws.close();
  });
  await page.reload();

  await expect(page.locator("#connection")).toHaveAttribute("data-state", "reconnecting");
  await page.waitForTimeout(4_000);
  // 間隔は 0.5〜1 秒、1〜2 秒、2〜4 秒と延びるので、4 秒で繋ぎに行くのは 1 本目のほかに 2〜3 回である。
  expect(opened).toBeGreaterThanOrEqual(3);
  expect(opened).toBeLessThanOrEqual(4);
  await expect(page.locator("#table")).toBeVisible();
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
 * 線が途中で切れると `close` はいつまでも来ない（3.5 節）。`ping` に答えない接続を
 * 切れたものと見なさないと、繋ぎ直しが始まらない。
 */
test("`ping` に答えなくなった接続は、閉じるのを待たずに繋ぎ直す", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つづいている座席" })),
  );
  let opened = 0;
  // 1 本目は座席を知っている印を返したあと、閉じずに黙る。
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    opened += 1;
    if (opened === 1) ws.send(JSON.stringify({ t: "pending" }));
  });
  await page.reload();
  await expect.poll(() => opened).toBe(1);
  // 印が画面に届くのを待つ。届く前に時計を進めると、印の無い接続として切られる。
  await page.waitForTimeout(500);

  // 1 回目の `ping` を送るところまで。まだ答えを待っている。
  await page.clock.runFor(30_000);
  expect(opened).toBe(1);
  // 次に送るときまでに答えが無いので、切れたものとして繋ぎ直す。
  await page.clock.runFor(30_000);
  await expect.poll(() => opened).toBe(2);
  await expect(page.locator("#table")).toBeVisible();
});

/**
 * タイマーは、隠れたタブでは間引かれ、眠っているあいだは止まる。黙っていた長さで決めると、
 * 戻った直後に、答えている接続まで切る。
 */
test("タイマーが大きく遅れても、`ping` に答えている接続は切らない", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.evaluate(() =>
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つづいている座席" })),
  );
  let opened = 0;
  let pings = 0;
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    opened += 1;
    ws.send(JSON.stringify({ t: "pending" }));
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).t !== "ping") return;
      pings += 1;
      ws.send(JSON.stringify({ t: "pong" }));
    });
  });
  await page.reload();
  await expect.poll(() => opened).toBe(1);
  await page.waitForTimeout(500);

  // 10 分ずつ 2 回飛ぶ。飛んだあとのタイマーは 1 回だけ動く。
  await page.clock.fastForward(600_000);
  await expect.poll(() => pings).toBe(1);
  await page.waitForTimeout(500);
  await page.clock.fastForward(600_000);
  await expect.poll(() => pings).toBe(2);
  await page.clock.runFor(2_000);
  expect(opened).toBe(1);
  await expect(page.locator("#connection")).toBeHidden();
});

test("観戦中に切れたら、繋ぎ直して続きを映す", async ({ browser, pageErrors }) => {
  const room = `かんせんもどる-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  await seatPair(a, b, room);
  await expect(a.locator("#watch-link")).not.toHaveValue("");
  const link = await a.locator("#watch-link").inputValue();

  const context = await browser.newContext();
  const watcher = watch(await context.newPage(), pageErrors);
  const held = gate();
  let opened = 0;
  await watcher.routeWebSocket(/\/ws\?/, async (client) => {
    opened += 1;
    const first = opened === 1;
    if (!first) await held.wait;
    const server = client.connectToServer();
    server.onMessage((raw) => {
      client.send(raw);
      if (first && JSON.parse(String(raw)).t === "spectator-sync") client.close();
    });
  });
  await watcher.goto(link);

  await expect(watcher.locator("#watch-status")).not.toBeEmpty();
  held.open();
  await expect(watcher.locator("#watch-status")).toBeEmpty();
  expect(opened).toBe(2);

  expect(await playEither(a, b)).toBe(true);
  await expect(watcher.locator("#watch-events li")).not.toHaveCount(0);

  await context.close();
  await close();
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
  await expect(a.locator("#self .mat").first()).toBeVisible();

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
  await expect(a.locator("#self .mat").first()).toBeVisible();

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
  await expect(a.locator("#self .mat").first()).toBeVisible();

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
  await expect(a.locator("#self .mat").first()).toBeVisible();

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");

  await expect(a.locator("#shuffle-check")).toHaveAttribute("data-result", "opponent-share-unused");
  await expect(b.locator("#shuffle-check")).toHaveAttribute("data-result", "ok");

  await close();
});

/**
 * デッキを組む画面。カードの名前はこのリポジトリへ書かないので、サーバの表から実行時に拾う。
 * サンプルデッキを、画面の検索から同じ中身で組み直す。
 */
async function sampleDeckEntries(
  page: Page,
): Promise<{ defId: string; name: string; count: number; set?: string; number?: string }[]> {
  const deck = (await (await page.request.get("/api/sample-deck")).json()) as { cards: string[] };
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string; set?: string; number?: string }
  >;
  const counts = new Map<string, number>();
  for (const defId of deck.cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  return [...counts].map(([defId, count]) => ({ defId, count, ...cards[defId] })) as {
    defId: string;
    name: string;
    count: number;
    set?: string;
    number?: string;
  }[];
}

/** 人がひらがなで打っても当たることを見るのに使う。 */
function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

test("検索して組んだデッキで対戦に入り、開き直してもデッキが残る", async ({
  browser,
  pageErrors,
}) => {
  const room = `くみたて-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  await Promise.all([a.goto("/"), b.goto("/")]);

  const entries = await sampleDeckEntries(a);
  for (const entry of entries) {
    // 収録も打つ。名前だけだと、版の多いカードは表示の上限に隠れることがある。
    const print = [entry.set, entry.number].filter(Boolean).join(" ");
    await a.fill("#card-search", `${toHiragana(entry.name)} ${print}`);
    const add = a.locator(`#card-results .card-row[data-def-id="${entry.defId}"] button.add`);
    for (let i = 0; i < entry.count; i++) await add.click();
    // サンプルデッキのポケモンは同じ名前を 4 枚ずつ入れてある。60 枚に届く前でも 5 枚目は押せない。
    if (entry.count === 4) await expect(add).toBeDisabled();
  }
  await expect(a.locator("#deck-count")).toHaveClass(/full/);

  await a.reload();
  await expect(a.locator("#deck-cards .card-row")).toHaveCount(entries.length);
  await expect(a.locator("#deck-count")).toHaveClass(/full/);

  const joined = a.waitForRequest((request) => request.url().endsWith("/api/join"));
  await join(a, room);
  const sent = (await joined).postDataJSON() as { deck: { cards: string[] } };
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();
  await expect(b.locator("#table")).toBeVisible();

  const expected = entries.flatMap((entry) => Array<string>(entry.count).fill(entry.defId));
  expect([...sent.deck.cards].sort()).toEqual(expected.sort());

  await close();
});

test("テキストの同じ名前の行は、候補を選ぶとデッキに入る", async ({ page }) => {
  await page.goto("/");
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string }
  >;
  const byName = new Map<string, string[]>();
  for (const [defId, card] of Object.entries(cards)) {
    byName.set(card.name, [...(byName.get(card.name) ?? []), defId]);
  }
  const [name, defIds] = [...byName].find(([, ids]) => ids.length > 1) as [string, string[]];

  await page.click(".deck-text summary");
  // 枚数を先に書いた行でも、選んだ defId が名前の一部として読まれないこと。
  await page.fill("#decklist", `4 ${name}`);
  await page.click("#import-button");
  const choices = page.locator("#deck-status .choices button");
  await expect(choices).toHaveCount(defIds.length);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(0);

  await choices.nth(1).click();
  const row = page.locator("#deck-cards .card-row");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".card-count")).toHaveText("4");

  // 減らしきった行は消える。
  for (let i = 0; i < 4; i++) await row.locator("button.remove").click();
  await expect(row).toHaveCount(0);
});

test("同じ名前のカードが並びきらなくても、ワザの名前を打ち足せば絞れる", async ({ page }) => {
  await page.goto("/");
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string; attacks?: string[] }
  >;
  const byName = new Map<string, string[]>();
  for (const [defId, card] of Object.entries(cards)) {
    byName.set(card.name, [...(byName.get(card.name) ?? []), defId]);
  }
  // 版の多い名前ほど、名前だけで探すと表示の上限に隠れやすい。いちばん多い名前の、並びの最後を選ぶ。
  const [name, defIds] = [...byName].sort(([, a], [, b]) => b.length - a.length)[0] as [
    string,
    string[],
  ];
  const target = [...defIds]
    .sort()
    .reverse()
    .find((defId) => (cards[defId]?.attacks ?? []).length > 0) as string;
  const attack = (cards[target]?.attacks as string[])[0] as string;

  await page.fill("#card-search", `${toHiragana(name)} ${attack}`);
  await expect(page.locator(`#card-results .card-row[data-def-id="${target}"]`)).toBeVisible();
});

test("ACE SPEC は 2 枚目を足せない", async ({ page }) => {
  await page.goto("/");
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string; aceSpec?: true }
  >;
  const [first, second] = Object.entries(cards).filter(([, card]) => card.aceSpec === true) as [
    [string, { name: string }],
    [string, { name: string }],
  ];

  await page.fill("#card-search", first[1].name);
  await page.locator(`#card-results .card-row[data-def-id="${first[0]}"] button.add`).click();
  await page.fill("#card-search", second[1].name);
  await expect(
    page.locator(`#card-results .card-row[data-def-id="${second[0]}"] button.add`),
  ).toBeDisabled();
});

test("カードの一覧を 1 度取れなくても、取り直して組めるようになる", async ({ page }) => {
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string }
  >;
  const name = (Object.values(cards)[0] as { name: string }).name;
  let failed = false;
  await page.route("**/api/cards", async (route) => {
    if (failed) return route.continue();
    failed = true;
    return route.fulfill({ status: 503, body: "" });
  });

  await page.goto("/");
  await expect.poll(() => failed).toBe(true);
  await page.fill("#card-search", name);
  // 取り直すまで間を空けるので、既定の待ち時間より長く待つ。
  await expect(page.locator("#card-results .card-row").first()).toBeVisible({ timeout: 15_000 });
});

test("テキスト欄に読み込んでいないリストがあれば、対戦に入らない", async ({ page }) => {
  const joins: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/join")) joins.push(request.url());
  });
  await page.goto("/");
  await page.click(".deck-text summary");
  await page.fill("#decklist", "貼ったまま 4");
  await page.click("#join-button");

  // 進めると、貼ったリストではなくサンプルデッキで対戦が始まる。
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
  await expect(page.locator("#join-status")).not.toBeEmpty();
  expect(joins).toEqual([]);
});

test("カードの一覧が空で届いても、検索で固まらない", async ({ page }) => {
  await page.route("**/api/cards", (route) => route.fulfill({ json: {} }));
  await page.goto("/");
  await page.fill("#card-search", "あ");
  await expect(page.locator("#card-results .note")).toBeVisible();
  // 描き直しが止まらないと、ページはこれに答えない。
  expect(await page.evaluate(() => 1)).toBe(1);
});

test("候補を出したあとにテキストを書き換えていたら、候補を押しても読み込まない", async ({
  page,
}) => {
  await page.goto("/");
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string }
  >;
  const counts = new Map<string, number>();
  for (const card of Object.values(cards)) counts.set(card.name, (counts.get(card.name) ?? 0) + 1);
  const names = [...counts].filter(([, count]) => count > 1).map(([name]) => name);

  await page.click(".deck-text summary");
  await page.fill("#decklist", `${names[0]} 4`);
  await page.click("#import-button");
  await expect(page.locator("#deck-status .choices button").first()).toBeVisible();
  // 同じ行を、別の名前に書き換えてから押す。
  await page.fill("#decklist", `${names[1]} 4`);
  await page.locator("#deck-status .choices button").first().click();

  await expect(page.locator("#deck-cards .card-row")).toHaveCount(0);
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
});

test("キーボードで「追加」を続けて押せて、押せなくなったら検索欄へ戻る", async ({ page }) => {
  await page.goto("/");
  const [entry] = await sampleDeckEntries(page);
  const { defId, name } = entry as { defId: string; name: string };
  await page.fill(
    "#card-search",
    `${name} ${[entry?.set, entry?.number].filter(Boolean).join(" ")}`,
  );
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Enter");

  await expect(
    page.locator(`#deck-cards .card-row[data-def-id="${defId}"] .card-count`),
  ).toHaveText("4");
  // 4 枚目で押せなくなったら、フォーカスは検索欄へ移る。ページの先頭へ落ちると、打ち直しから始まる。
  await expect(page.locator("#card-search")).toBeFocused();
});

/** 1 ピクセルの PNG。公式の画像の代わりに返す。 */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 画像を出す設定にして、画像の応答を `respond` で返させる。
 * テストのサーバは画像を切ってあるので、設定の応答ごと差し替える。
 */
async function withCardImages(
  page: Page,
  respond: (route: Parameters<Parameters<Page["route"]>[1]>[0]) => Promise<void>,
): Promise<void> {
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", respond);
}

test("画像を出す設定なら、盤面の見えるカードに画像が載る", async ({ browser, pageErrors }) => {
  const room = `がぞう-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const asked: string[] = [];
  await withCardImages(a, async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  const hand = a.locator('#self [data-zone="hand"] .card');
  await expect(hand.first()).toBeVisible();
  await expect(a.locator('#self [data-zone="hand"] .card img').first()).toBeVisible();
  // 頼むのは cardID で、`defId` ではない。
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((path) => /^\/api\/card-image\/[0-9]+$/.test(path))).toBe(true);
  // 相手の手札は裏のままで、画像を頼まない。
  await expect(a.locator('#opponent [data-zone="hand"] .card img')).toHaveCount(0);

  await hand.first().click();
  await expect(a.locator("#card-zoom")).toBeVisible();
  await expect(a.locator("#card-zoom-cards .card")).toHaveCount(1);
  await a.click("#card-zoom-close");
  await expect(a.locator("#card-zoom")).toBeHidden();

  await close();
});

test("画像を読めなかったカードは、名前の面で残る", async ({ browser, pageErrors }) => {
  const room = `がぞうなし-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  let asked = 0;
  await withCardImages(a, (route) => {
    asked += 1;
    return route.fulfill({ status: 502, body: "" });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  const hand = a.locator('#self [data-zone="hand"] .card');
  await expect(hand.first()).toBeVisible();
  await expect(a.locator('#self [data-zone="hand"] .card img')).toHaveCount(0);
  await expect(hand.first().locator(".card-name")).not.toBeEmpty();

  /**
   * 盤面は 1 手ごとに描き直す。読めなかった画像を覚えていないと、公式が落ちているあいだ
   * 1 手ごとに全部のカードを頼み直す。
   */
  const before = asked;
  const events = a.locator("#events li");
  const seen = await events.count();
  while (!(await playOne(a)) && !(await playOne(b)));
  await expect(events).not.toHaveCount(seen);
  expect(asked).toBe(before);

  await close();
});

test("画像を切ってある設定では、画像を頼まない", async ({ browser, pageErrors }) => {
  const room = `きってある-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const asked: string[] = [];
  a.on("request", (request) => {
    if (request.url().includes("/api/card-image/")) asked.push(request.url());
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator('#self [data-zone="hand"] .card').first()).toBeVisible();
  await expect(a.locator('#self [data-zone="deck"]')).toHaveAttribute("data-count", /^[0-9]+$/);
  expect(asked).toEqual([]);

  await close();
});

test("画像を出す設定なら、デッキを組む画面の候補にも画像が載る", async ({ page }) => {
  await withCardImages(page, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
  );
  await page.goto("/");
  await page.fill("#card-search", "エネルギー");
  await expect(page.locator("#card-results .card-row").first()).toBeVisible();
  await expect(page.locator("#card-results .card-row .card.thumb img").first()).toBeVisible();
});
