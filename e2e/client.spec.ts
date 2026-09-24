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
import { loadGeneratedCards } from "../src/engine.js";

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
    // 準備はまとめて出す。バトル場だけ選び、ベンチは空のまま出す。
    if (await page.locator("#setup-submit").isVisible()) {
      await page.locator("#setup-active button").first().click({ timeout: 1_000 });
      await page.locator("#setup-submit").click({ timeout: 1_000 });
      return true;
    }
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
  const seenA = lastSeen(a);
  const seenB = lastSeen(b);

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  // 先に入ったほうはチケットを持って待つ。2 人目が入った時点で席が決まる。
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  await expect(a.locator("#table")).toBeVisible();
  await expect(b.locator("#table")).toBeVisible();

  /**
   * **手が並ぶのは片側だけである。** サーバは手番でない座席へ `legalMoves` を送らない。
   * 両方に並ぶなら、射影ではなく生の局面が流れている。準備は両座席が同時に出すので、済ませてから見る。
   */
  await expect.poll(() => seenA()?.phase).toBe("setup");
  while (seenA()?.phase === "setup") await advance(a, b, seenA);
  await expect.poll(() => seenA()?.phase).not.toBe("setup");
  await expect.poll(() => seenB()?.phase).not.toBe("setup");
  for (const page of [a, b]) {
    await expect(page.locator("#moves button, #moves .waiting").first()).toBeVisible();
  }
  const counts = await Promise.all([
    a.locator("#moves button").count(),
    b.locator("#moves button").count(),
  ]);
  expect(counts.filter((count) => count > 0)).toHaveLength(1);

  await close();
});

interface Seen {
  stateVersion: number;
  phase: string;
  viewer: number;
  choice: { owner: number; kind: string } | undefined;
  /** サーバが送った準備の状態（`choose` か `submitted`）。 */
  setup: string | null;
  hand: { instanceId: string; defId: string }[];
  activeDefId: string | null;
  benchCount: number;
}

interface SeenPokemon {
  stack: { defId: string }[];
}

/**
 * 局面を運ぶメッセージから、画面の文言を読まずに準備のどこにいるかを知るための値を取り出す。
 * 選択の `kind` と持ち主は、持ち主でない座席の射影にも載る。
 */
function seenIn(message: {
  t: string;
  stateVersion?: number;
  setup?: { kind: string } | null;
  view?: {
    phase: string;
    viewer: number;
    choices: { owner: number; kind: string }[];
    self: {
      hand: { instanceId: string; defId: string }[];
      active: SeenPokemon | null;
      bench: (SeenPokemon | null)[];
    };
  };
}): Seen | null {
  if ((message.t !== "sync" && message.t !== "delta") || message.view === undefined) return null;
  const { view } = message;
  return {
    stateVersion: message.stateVersion ?? -1,
    phase: view.phase,
    viewer: view.viewer,
    choice: view.choices.at(-1),
    setup: message.setup?.kind ?? null,
    hand: view.self.hand,
    activeDefId: view.self.active?.stack.at(-1)?.defId ?? null,
    benchCount: view.self.bench.filter((pokemon) => pokemon !== null).length,
  };
}

function lastSeen(page: Page): () => Seen | null {
  let seen: Seen | null = null;
  page.on("websocket", (socket) => {
    socket.on("framereceived", ({ payload }) => {
      seen = seenIn(JSON.parse(String(payload))) ?? seen;
    });
  });
  return () => seen;
}

/**
 * 自分の番の途中で相手が選ぶ局面（きぜつしたあとにバトル場へ出すポケモンなど）は、きぜつまで
 * 指さないと来ない。準備も手番のプレイヤーでない側が選ぶので、その `phase` を書き換えて作る。
 * まとめて出す準備の状態も落とし、エンジンの選択を 1 つずつ答える画面にする。
 */
async function relabelSetupAsMain(page: Page): Promise<() => Seen | null> {
  let seen: Seen | null = null;
  await page.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.view?.phase === "setup") message.view.phase = "main";
      if (message.setup !== undefined) message.setup = null;
      seen = seenIn(message) ?? seen;
      client.send(JSON.stringify(message));
    });
  });
  return () => seen;
}

/** 1 手指し、その局面が届くまで待つ。待たずに続けると、古い局面を見て次の手を選ぶ。 */
async function advance(a: Page, b: Page, seen: () => Seen | null): Promise<void> {
  const before = seen()?.stateVersion ?? -1;
  expect(await playEither(a, b)).toBe(true);
  await expect.poll(() => seen()?.stateVersion ?? -1).toBeGreaterThan(before);
}

/**
 * `page` の座席が準備をまとめて出せるところまで進める。引き直す座席なら、たねのある相手が
 * 先にサイドまで進んでから引き直すので（公式ルールガイド「G 対戦準備」5.b）、手番の側に先に出させる。
 */
async function untilChoose(
  page: Page,
  other: Page,
  seen: () => Seen | null,
  seenOther: () => Seen | null,
): Promise<void> {
  await expect.poll(() => seen()?.phase).toBe("setup");
  await expect.poll(() => seenOther()?.phase).toBe("setup");
  while (seen()?.setup !== "choose") {
    const before = seen()?.stateVersion ?? -1;
    const mover = seen()?.choice?.owner === seen()?.viewer ? page : other;
    await expect(mover.locator("#setup-submit:visible, #moves button").first()).toBeVisible();
    expect(await playOne(mover)).toBe(true);
    await expect.poll(() => seen()?.stateVersion ?? -1).toBeGreaterThan(before);
  }
}

/**
 * 両座席がそろって準備を出せる対戦を開く。片方だけが引き直す対戦では、たねのある側しか先に出せないので、
 * そうなったら閉じて別の対戦を開き直す。どちらになるかは seed で決まり、テストからは選べない。
 */
async function pairBothChoosing(
  browser: Browser,
  errors: string[],
  prefix: string,
): Promise<{
  a: Page;
  b: Page;
  seenA: () => Seen | null;
  seenB: () => Seen | null;
  close: () => Promise<void>;
}> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [a, b, close] = await openPair(browser, errors);
    const seenA = lastSeen(a);
    const seenB = lastSeen(b);
    await seatPair(a, b, `${prefix}-${Date.now()}-${attempt}`);
    await expect.poll(() => seenA()?.phase).toBe("setup");
    await expect.poll(() => seenB()?.phase).toBe("setup");
    if (seenA()?.setup === "choose" && seenB()?.setup === "choose") {
      return { a, b, seenA, seenB, close };
    }
    await close();
  }
  throw new Error("両座席がそろって準備を出せる対戦が開けない");
}

/**
 * 実際のポケカでは両者が裏向きで同時に置く。エンジンは 1 人ずつの選択に並べるが、
 * 番の来ていない側の答えもサーバが預かるので、後攻が先に出しても待たされない。
 */
test("対戦準備は、番を待たずに両座席がバトル場とベンチを選んで出せる", async ({
  browser,
  pageErrors,
}) => {
  const { a, b, seenA, seenB, close } = await pairBothChoosing(browser, pageErrors, "じゅんび");

  const [first, second] = seenA()?.choice?.owner === seenA()?.viewer ? [a, b] : [b, a];
  const seenSecond = second === a ? seenA : seenB;
  const active = second.locator("#setup-active button").first();
  await active.click();
  await expect(active).toHaveAttribute("aria-pressed", "true");
  const pickedId = await active.getAttribute("data-instance-id");
  const pickedDefId = seenSecond()?.hand.find((card) => card.instanceId === pickedId)?.defId;
  const benchable = await second.locator("#setup-bench button").count();
  if (benchable > 0) await second.locator("#setup-bench button").first().click();
  await second.locator("#setup-submit").click();

  // 出した側は待ちになり、まだ選んでいる先攻もそのまま選べる。
  await expect(second.locator("#setup")).toBeHidden();
  await expect(second.locator("#move-prompt")).toBeVisible();
  await expect(second.locator("#moves button")).toHaveCount(0);
  await expect(second.locator("#moves .waiting")).toHaveCount(0);
  await expect(first.locator("#setup")).toBeVisible();

  await first.locator("#setup-active button").first().click();
  await first.locator("#setup-submit").click();
  await expect.poll(() => seenSecond()?.phase).not.toBe("setup");
  expect(seenSecond()?.activeDefId).toBe(pickedDefId);
  expect(seenSecond()?.benchCount).toBe(benchable > 0 ? 1 : 0);
  for (const page of [a, b]) {
    await expect(page.locator("#setup")).toBeHidden();
    await expect(page.locator("#move-prompt")).toBeHidden();
  }

  await close();
});

test("「準備を終える」は返事が来るまで押せず、続けて押しても答えは 1 通だけ送る", async ({
  browser,
  pageErrors,
}) => {
  const room = `にどおし-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const seenA = lastSeen(a);
  let seenB: Seen | null = null;
  let setups = 0;
  // 答えを送ってからの返事は止めておき、押せなくなっているかを返事の前に確かめる。
  const hold: { queue: (() => void)[] | null } = { queue: null };
  await b.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    client.onMessage((raw) => {
      if (JSON.parse(String(raw)).t === "setup") {
        setups += 1;
        hold.queue ??= [];
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const deliver = () => {
        seenB = seenIn(JSON.parse(String(raw))) ?? seenB;
        client.send(raw);
      };
      if (hold.queue === null) deliver();
      else hold.queue.push(deliver);
    });
  });
  await seatPair(a, b, room);
  await untilChoose(b, a, () => seenB, seenA);

  await b.locator("#setup-active button").first().click();
  await b.locator("#setup-submit").dblclick();
  await expect(b.locator("#setup-submit")).toBeDisabled();
  await expect.poll(() => setups).toBe(1);

  const queued = hold.queue ?? [];
  hold.queue = null;
  for (const deliver of queued) deliver();
  await expect(b.locator("#setup")).toBeHidden();
  expect(setups).toBe(1);

  await close();
});

test("自分の番の途中で相手が選んでいるあいだは、相手の番と出さない", async ({
  browser,
  pageErrors,
}) => {
  const room = `とちゅう-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const seen = await relabelSetupAsMain(a);
  await relabelSetupAsMain(b);
  await seatPair(a, b, room);
  await expect.poll(() => seen()?.choice?.kind).toBeDefined();

  // 最初にバトル場を選ぶのは手番のプレイヤー（先攻）である。
  while (seen()?.choice?.kind !== "setup-place-active") await advance(a, b, seen);
  const [first, second] = seen()?.choice?.owner === seen()?.viewer ? [a, b] : [b, a];
  await expect(second.locator("#moves .waiting")).toHaveAttribute("data-state", "their-turn");

  // 先攻が出すと、先攻の番のまま後攻が選ぶ。
  await advance(a, b, seen);
  await expect(first.locator("#moves .waiting")).toHaveAttribute("data-state", "their-choice");

  await close();
});

/**
 * 相手が引き直したことは、相手に番が回る前に起きる。できごとの欄に流れるだけだと、準備を選んでいるうちに
 * 見落とす。どちらが引き直すかは seed で決まるので、届いた局面に相手のマリガンを書き足して作る。
 */
test("引き直しで見せた手札は、準備のあいだ開いた欄に並び、対戦が始まったら畳む", async ({
  browser,
  pageErrors,
}) => {
  const room = `ひきなおし-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const seenA: { last: Seen | null } = { last: null };
  await a.routeWebSocket(/\/ws\?/, (client) => {
    const server = client.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.view !== undefined && Array.isArray(message.mulligans)) {
        const shown = message.view.self.hand.map((card: { defId: string }) => card.defId);
        message.mulligans = [{ player: 1 - message.view.viewer, cards: shown }];
      }
      seenA.last = seenIn(message) ?? seenA.last;
      client.send(JSON.stringify(message));
    });
  });
  await seatPair(a, b, room);

  const panel = a.locator("#mulligans");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("open", "");
  const row = a.locator('#mulligan-list .mulligan[data-side="opponent"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".card")).not.toHaveCount(0);

  while (seenA.last?.phase === "setup") await advance(a, b, () => seenA.last);
  await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute("open", "");

  // 対戦が始まってから開いた欄は、次の局面が届いても開いたままにする。
  await panel.locator("summary").click();
  await expect(panel).toHaveAttribute("open", "");
  await advance(a, b, () => seenA.last);
  await expect(panel).toHaveAttribute("open", "");

  await close();
});

/** 座席へ戻った直後は、名前の表より先に局面が届くことがある。 */
test("名前の表が局面より遅れて届いたら、準備の候補の名前も描き直す", async ({
  browser,
  pageErrors,
}) => {
  const room = `なまえ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  const seenA = lastSeen(a);
  const seenB = lastSeen(b);
  await seatPair(a, b, room);
  await untilChoose(a, b, seenA, seenB);

  const names = gate();
  await a.route("**/api/cards", async (route) => {
    await names.wait;
    await route.continue();
  });
  await a.reload();
  const candidate = a.locator("#setup-active button").first();
  await expect(candidate).toBeVisible();
  const before = await candidate.textContent();
  names.open();
  await expect(candidate).not.toHaveText(before ?? "");

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

test("横に広い画面では、対戦のあいだリプレイの欄を出さず、決着したら戻す", async ({
  browser,
  pageErrors,
}) => {
  const room = `たたむ-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  await a.setViewportSize({ width: 1920, height: 900 });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect(a.locator("#table")).toBeVisible();
  await expect(a.locator("#history")).toBeHidden();
  // ページがスクロールできると、盤面の上でホイールを回したときに盤面ごとずれる。
  expect(
    await a.evaluate(() => {
      const root = Reflect.get(globalThis, "document").documentElement as { scrollHeight: number };
      return root.scrollHeight - (Reflect.get(globalThis, "innerHeight") as number);
    }),
  ).toBeLessThanOrEqual(0);

  a.once("dialog", (dialog) => void dialog.accept());
  await a.click("#concede-button");
  await expect(a.locator("#history")).toBeVisible();

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

/**
 * どちらかの座席で 1 手ぶん局面を動かす。準備は両座席がそろってはじめて動くので、
 * 出せる座席がそろって出す。
 */
async function playEither(a: Page, b: Page): Promise<boolean> {
  const setup = [];
  for (const page of [a, b]) if (await page.locator("#setup-submit").isVisible()) setup.push(page);
  if (setup.length > 0) {
    for (const page of setup) await playOne(page);
    // マリガンの追加ドローを答えていない座席は、まだ準備を出せない。それを答えれば局面が動く。
    for (const page of [a, b]) if (!setup.includes(page)) await playOne(page);
    return true;
  }
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

  expect(await playEither(a, b)).toBe(true);
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
  const seenA = lastSeen(a);
  const seenB = lastSeen(b);
  const asked: string[] = [];
  await withCardImages(a, (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 502, body: "" });
  });

  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);
  await expect.poll(() => seenA()?.phase).toBe("setup");
  await expect.poll(() => seenB()?.phase).toBe("setup");

  const hand = a.locator('#self [data-zone="hand"] .card');
  await expect(hand.first()).toBeVisible();
  await expect(a.locator('#self [data-zone="hand"] .card img')).toHaveCount(0);
  await expect(hand.first().locator(".card-name")).not.toBeEmpty();

  /**
   * 盤面は 1 手ごとに描き直す。読めなかった画像を覚えていないと、公式が落ちているあいだ
   * 1 手ごとに全部のカードを頼み直す。準備が終わる手で相手の場が表になり、初めて出る画像は頼む。
   */
  const events = a.locator("#events li");
  const seen = await events.count();
  expect(await playEither(a, b)).toBe(true);
  await expect(events).not.toHaveCount(seen);
  expect(asked.length).toBeGreaterThan(0);
  expect(new Set(asked).size).toBe(asked.length);

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

/**
 * 公式サイトのデッキ確認ページの代わり。欄の形は公式のページに合わせてある。
 * カード ID はこのリポジトリへ書かないので、正規データの収録から実行時に拾う。
 */
function officialPage(
  fields: Record<string, { cardId: string; count: number }[]>,
  names: Record<string, string> = {},
): string {
  const inputs = Object.entries(fields).map(
    ([id, cards]) =>
      `<input type="hidden" name="${id}" id="${id}" value="${cards.map((card) => `${card.cardId}_${card.count}_1`).join("-")}" />`,
  );
  const script = Object.entries(names)
    .map(([cardId, name]) => `PCGDECK.searchItemName[${cardId}]='${name}';`)
    .join("\n");
  return `<!DOCTYPE html><html><body><form>${inputs.join("")}</form><script>${script}</script></body></html>`;
}

const OFFICIAL_PAGE = "https://www.pokemon-card.com/deck/confirm.html/deckID/**";

/** カード ID → それを収録に持つ `defId`。 */
function cardIds(): Map<string, string[]> {
  const built = new Map<string, string[]>();
  for (const def of loadGeneratedCards()) {
    for (const print of def.prints) {
      built.set(print.cardID, [...(built.get(print.cardID) ?? []), def.defId]);
    }
  }
  return built;
}

test("公式のデッキコードで読み込むと、無いカードだけを名前で出し、残りはデッキに入る", async ({
  page,
}) => {
  await page.goto("/");
  const deck = (await (await page.request.get("/api/sample-deck")).json()) as { cards: string[] };
  const counts = new Map<string, number>();
  for (const defId of deck.cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  const byDefId = new Map<string, string>();
  for (const [cardId, defIds] of cardIds()) {
    if (defIds.length === 1) byDefId.set(defIds[0] as string, cardId);
  }
  const known = [...counts].map(([defId, count]) => ({
    cardId: byDefId.get(defId) as string,
    count,
  }));
  const missing = String(Math.max(...[...cardIds().keys()].map(Number)) + 1);
  const requested: string[] = [];
  await page.route(OFFICIAL_PAGE, (route) => {
    requested.push(route.request().url());
    return route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: officialPage(
        { deck_pke: [...known, { cardId: missing, count: 1 }], deck_gds: [], deck_ajs: [] },
        { [missing]: "このサーバに無いカード" },
      ),
    });
  });

  // デッキのページの URL を貼っても読む。
  await page.fill(
    "#deck-code",
    `https://www.pokemon-card.com/deck/confirm.html/deckID/abc123-DEF456-ghi789/`,
  );
  await page.click("#deck-code-button");

  await expect(page.locator("#deck-cards .card-row")).toHaveCount(counts.size);
  expect(requested).toEqual([
    "https://www.pokemon-card.com/deck/confirm.html/deckID/abc123-DEF456-ghi789/",
  ]);
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
  await expect(page.locator("#deck-status")).toContainText("このサーバに無いカード");
  for (const [defId, count] of counts) {
    await expect(
      page.locator(`#deck-cards .card-row[data-def-id="${defId}"] .card-count`),
    ).toHaveText(String(count));
  }
});

test("公式のデッキコードが見つからなければ、組んでいるデッキを残す", async ({ page }) => {
  await page.goto("/");
  const [entry] = await sampleDeckEntries(page);
  const { defId, name } = entry as { defId: string; name: string };
  await page.fill(
    "#card-search",
    `${name} ${[entry?.set, entry?.number].filter(Boolean).join(" ")}`,
  );
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).click();
  // 見つからないコードでも、公式のページは空の欄を並べて返す。
  await page.route(OFFICIAL_PAGE, (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: officialPage({ deck_pke: [], deck_gds: [], deck_ene: [] }),
    }),
  );

  page.once("dialog", (dialog) => dialog.accept());
  await page.fill("#deck-code", "nothing-here-000000");
  await page.click("#deck-code-button");

  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
});

test("公式のカード ID で定義が決まらないカードは、枚数に届くまで候補を 1 枚ずつ選べる", async ({
  page,
}) => {
  await page.goto("/");
  const [cardId, defIds] = [...cardIds()].find(([, ids]) => ids.length > 1) as [string, string[]];
  await page.route(OFFICIAL_PAGE, (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: officialPage({ deck_sta: [{ cardId, count: 2 }] }),
    }),
  );

  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  const choices = page.locator("#deck-status .choices button");
  await expect(choices).toHaveCount(defIds.length);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(0);

  // 左右 2 枚で 1 つのスタジアムは、左と右を 1 枚ずつ入れられなければ場に出せない。
  const sorted = [...defIds].sort();
  await choices.nth(0).click();
  await choices.nth(1).click();
  for (const defId of sorted.slice(0, 2)) {
    await expect(
      page.locator(`#deck-cards .card-row[data-def-id="${defId}"] .card-count`),
    ).toHaveText("1");
  }
  await expect(choices).toHaveCount(0);
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
});

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("カードにマウスを載せると横に大きく出て、外すと消える", async ({ browser, pageErrors }) => {
  const room = `のせる-${Date.now()}`;
  const [a, b, close] = await openPair(browser, pageErrors);
  await Promise.all([a.goto("/"), b.goto("/")]);
  await join(a, room);
  await expect(a.locator("#join-status")).not.toBeEmpty();
  await join(b, room);

  const hand = a.locator('#self [data-zone="hand"] .card');
  const preview = a.locator("#card-preview");
  await expect(hand.first()).toBeVisible();
  // 「対戦をさがす」を押したマウスの位置には、盤面が開くとカードが来ることがある。
  await a.mouse.move(0, 0);
  await expect(preview).toBeHidden();

  const card = hand.last();
  const defId = await card.getAttribute("data-def-id");
  // プレビューは読み上げない。同じ説明をカードそのものが持つ。
  await expect(preview).toHaveAttribute("aria-hidden", "true");
  await expect(card.locator(".visually-hidden")).not.toBeEmpty();
  await card.hover();
  await expect(preview).toBeVisible();
  await expect(preview.locator(".card")).toHaveAttribute("data-def-id", defId as string);
  const shown = (await preview.boundingBox()) as Box;
  const under = (await card.boundingBox()) as Box;
  const viewport = a.viewportSize() as { width: number; height: number };
  expect(shown.width).toBeGreaterThan(under.width * 2);
  expect(overlaps(shown, under)).toBe(false);
  expect(shown.x).toBeGreaterThanOrEqual(0);
  expect(shown.y).toBeGreaterThanOrEqual(0);
  expect(shown.x + shown.width).toBeLessThanOrEqual(viewport.width);
  expect(shown.y + shown.height).toBeLessThanOrEqual(viewport.height);

  // 盤面の描き直しと同じく、載せているカードを差し替える。閉じずに、マウスの下に来た方へ移る。
  const hides = await preview.evaluateHandle((node) => {
    const seen = { count: 0 };
    // この tsconfig は DOM の型を読まないので、ページの側から引く。
    const Observer = Reflect.get(globalThis, "MutationObserver");
    new Observer(() => {
      if (node.hidden) seen.count += 1;
    }).observe(node, { attributes: true, attributeFilter: ["hidden"] });
    return seen;
  });
  const other = "差し替えたカード";
  await card.evaluate((node, defId) => {
    const replacement = node.cloneNode() as typeof node;
    replacement.dataset.defId = defId;
    node.replaceWith(replacement);
  }, other);
  await expect(preview.locator(".card")).toHaveAttribute("data-def-id", other);
  expect(await hides.evaluate((seen) => seen.count)).toBe(0);

  // 下にカードが無くなったら閉じる。
  await hand.evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await expect(preview).toBeHidden();
  await expect(hand).toHaveCount(0);
  while (!(await playOne(a)) && !(await playOne(b)));
  await expect(hand.first()).toBeVisible();

  await hand.first().hover();
  await expect(preview).toBeVisible();
  await a.mouse.move(0, 0);
  await expect(preview).toBeHidden();

  // 押して開く拡大の中では出さない。
  await hand.first().click();
  await expect(a.locator("#card-zoom")).toBeVisible();
  await expect(preview).toBeHidden();
  await a.locator("#card-zoom-cards .card").first().hover();
  await expect(preview).toBeHidden();

  await close();
});

test("一覧を送ると、プレビューもカードに付いていく", async ({ page }) => {
  // プレビューが画面の上下の端で止まらない高さにして、カードとの位置の関係だけを見る。
  await page.setViewportSize({ width: 1280, height: 1600 });
  await withCardImages(page, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
  );
  await page.goto("/");
  await page.fill("#card-search", "エネルギー");
  const thumb = page.locator("#card-results .card-row .card").nth(3);
  await expect(thumb).toBeVisible();
  const preview = page.locator("#card-preview");
  await thumb.hover();
  await expect(preview).toBeVisible();
  const offset = async (): Promise<number> =>
    ((await preview.boundingBox()) as Box).y - ((await thumb.boundingBox()) as Box).y;
  const before = await offset();

  await page.locator("#card-results").evaluate((node) => node.scrollBy(0, 10));
  await expect.poll(offset).toBeCloseTo(before, 0);
  expect(((await preview.boundingBox()) as Box).y).toBeGreaterThan(8);
});

test.describe("タッチ端末", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  /** CDP で指を置く。Playwright の `tap` は置いてすぐ離すので、長押しを作れない。 */
  async function finger(
    page: Page,
    box: Box,
  ): Promise<{ slide: (dy: number) => Promise<void>; lift: () => Promise<void> }> {
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    return {
      slide: async (dy) => {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: point.x, y: point.y + dy }],
        });
      },
      lift: async () => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      },
    };
  }

  test("長押しのあいだだけ大きく出る", async ({ page }) => {
    await withCardImages(page, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: PIXEL }),
    );
    await page.goto("/");
    await page.fill("#card-search", "エネルギー");
    const thumb = page.locator("#card-results .card-row .card").first();
    await expect(thumb).toBeVisible();
    const defId = await thumb.getAttribute("data-def-id");
    const preview = page.locator("#card-preview");
    const box = (await thumb.boundingBox()) as Box;

    // 見るのは、画面が長押しのメニューを止めたかどうかと、クリックが画面の処理まで届いたか。
    const menus = await thumb.evaluateHandle((node) => {
      const prevented: boolean[] = [];
      node.ownerDocument.addEventListener("contextmenu", (event: { defaultPrevented: boolean }) =>
        prevented.push(event.defaultPrevented),
      );
      return prevented;
    });
    // 画面より後に付けた capture のリスナーは画面が止めても呼ばれ、bubble のリスナーは呼ばれない。
    const clicks = await thumb.evaluateHandle((node) => {
      const counts = { sent: 0, reached: 0 };
      node.ownerDocument.addEventListener("click", () => (counts.sent += 1), { capture: true });
      node.ownerDocument.addEventListener("click", () => (counts.reached += 1));
      return counts;
    });

    const pressed = await finger(page, box);
    await expect(preview).toBeVisible();
    await expect(preview.locator(".card")).toHaveAttribute("data-def-id", defId as string);
    await expect(preview.locator(".card img")).toBeVisible();
    const shown = (await preview.boundingBox()) as Box;
    expect(overlaps(shown, box)).toBe(false);
    expect(shown.x + shown.width).toBeLessThanOrEqual(390);
    // ヘッドレスの Chromium は長押しでメニューを出さないので、届いたときの扱いを直に見る。
    await thumb.dispatchEvent("contextmenu");
    await pressed.lift();
    await expect(preview).toBeHidden();
    // 離したときに届くクリックは長押しの続きなので、拡大を開かせない。次に押したときのクリックは通す。
    await expect
      .poll(() => clicks.evaluate((counts) => ({ ...counts })))
      .toEqual({ sent: 1, reached: 0 });
    await thumb.tap();
    expect(await clicks.evaluate((counts) => counts.reached)).toBe(1);

    // 指をずらすと閉じる。そのときはクリックが来ないので、次に押したときのクリックを止めない。
    const slid = await finger(page, box);
    await expect(preview).toBeVisible();
    await slid.slide(30);
    await expect(preview).toBeHidden();
    await slid.lift();
    await thumb.tap();
    expect(await clicks.evaluate((counts) => counts.reached)).toBe(2);
    await expect(preview).toBeHidden();
    // 長押しでないときのメニューは止めない。
    await thumb.dispatchEvent("contextmenu");
    expect(await menus.evaluate((prevented) => [...prevented])).toEqual([true, false]);
  });
});

test("公式サイトの返事を待つあいだにデッキを組み替えたら、置き換えない", async ({ page }) => {
  await page.goto("/");
  const deck = (await (await page.request.get("/api/sample-deck")).json()) as { cards: string[] };
  const byDefId = new Map<string, string>();
  for (const [cardId, defIds] of cardIds()) {
    if (defIds.length === 1) byDefId.set(defIds[0] as string, cardId);
  }
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(OFFICIAL_PAGE, async (route) => {
    await held;
    await route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: officialPage({
        deck_ene: [
          { cardId: byDefId.get(deck.cards[deck.cards.length - 1] as string) as string, count: 4 },
        ],
      }),
    });
  });

  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  const [entry] = await sampleDeckEntries(page);
  const { defId, name } = entry as { defId: string; name: string };
  await page.fill(
    "#card-search",
    `${name} ${[entry?.set, entry?.number].filter(Boolean).join(" ")}`,
  );
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).click();
  release();

  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
  await expect(page.locator(`#deck-cards .card-row[data-def-id="${defId}"]`)).toHaveCount(1);
});

/**
 * 中盤の混んだ局面を 1 通の `sync` にする。両者のベンチが埋まり、進化とエネルギーとどうぐが載り、
 * 手札も多い。盤面の大きさだけを見るので、手はサーバに頼まず、この局面を直に送る。
 */
function crowdedSync(handSize: number): object {
  const defs = loadGeneratedCards();
  const pick = (test: (def: (typeof defs)[number]) => boolean): string =>
    (defs.find(test) as (typeof defs)[number]).defId;
  const basic = pick((def) => def.kind === "pokemon" && def.evolutionStage === "basic");
  const stage2 = pick((def) => def.kind === "pokemon" && def.evolutionStage === "stage2");
  const energy = pick((def) => def.kind === "energy");
  const tool = pick((def) => def.kind === "trainer" && def.trainerKind === "tool");
  const item = pick((def) => def.kind === "trainer" && def.trainerKind === "item");
  const stadium = pick((def) => def.kind === "trainer" && def.trainerKind === "stadium");

  let serial = 0;
  const card = (defId: string): object => ({ instanceId: `c${++serial}`, defId });
  const pokemon = (top: string, damage: number, conditions: string[] = []): object => ({
    inPlayId: `p${++serial}`,
    stack: [basic, top].map(card),
    attached: [energy, energy, energy, tool].map(card),
    damage,
    conditions: conditions.map((kind) => ({ kind })),
    pendingKnockoutCause: null,
    placedOnTurn: 1,
    becameActiveOnTurn: null,
  });
  const bench = (): object[] =>
    Array.from({ length: 5 }, (_, index) => pokemon(stage2, index * 10));
  const pile = (): object[] => [item, energy, tool].map(card);
  const common = { prizeCount: 3, faceUpPrizes: [], discard: pile(), lostZone: pile() };
  const hand = Array.from({ length: handSize }, (_, index) =>
    card([basic, stage2, energy, tool, item][index % 5] as string),
  );
  return {
    t: "sync",
    matchId: "混んだ局面",
    seat: 0,
    stateVersion: 1,
    view: {
      phase: "main",
      turn: 9,
      turnPlayer: 0,
      turnFlags: {},
      choices: [],
      outcome: null,
      viewer: 0,
      stadium: card(stadium),
      self: {
        ...common,
        hand,
        deckCount: 20,
        active: pokemon(stage2, 120, ["poisoned"]),
        bench: bench(),
      },
      opponent: {
        ...common,
        handCount: 30,
        deckCount: 20,
        active: pokemon(stage2, 90, ["asleep"]),
        bench: bench(),
      },
    },
    legalMoves: [
      ...hand.map(() => ({ type: "AttachEnergy" })),
      { type: "Attack", attackIndex: 0 },
      { type: "EndTurn" },
    ],
    setup: null,
    mulligans: [],
    clock: { bankMs: [600_000, 600_000], moveRemainingMs: 60_000, toMove: 0 },
    seedCommit: "0".repeat(64),
    spectatorToken: "観戦",
  };
}

/** 要素の枠がすべて `bounds` の中にあること。スクロールで隠れた部分も枠は返るので、見えているかをこれで見る。 */
async function expectInside(page: Page, selector: string, bounds: Box): Promise<void> {
  const boxes = await page
    .locator(selector)
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON() as Box));
  expect(boxes.length, selector).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.x, selector).toBeGreaterThanOrEqual(bounds.x);
    expect(box.y, selector).toBeGreaterThanOrEqual(bounds.y);
    expect(box.x + box.width, selector).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y + box.height, selector).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
}

/** 盤面の欄の枠とビューポートの重なり。盤面がビューポートより長くても、欄より広くても、はみ出た部分は見えない。 */
async function visibleBoard(page: Page, section: string): Promise<Box> {
  const board = (await page.locator(`${section} .board`).boundingBox()) as Box;
  const viewport = page.viewportSize() as { width: number; height: number };
  return {
    x: Math.max(board.x, 0),
    y: Math.max(board.y, 0),
    width: Math.min(board.x + board.width, viewport.width) - Math.max(board.x, 0),
    height: Math.min(board.y + board.height, viewport.height) - Math.max(board.y, 0),
  };
}

const ZONES = ["hand", "prizes", "active", "bench", "deck", "discard", "lost"];

/**
 * FHD のモニターでブラウザを最大化し、ブックマークバーまで出したときのビューポート、
 * 同じモニターを 125% に拡大したときのビューポート、縦に置いた FHD のモニター。
 * どれでも、ページをスクロールせずに両者の盤面と手札、指せる手、時計が見えていること。
 */
for (const viewport of [
  { width: 1920, height: 900 },
  { width: 1536, height: 730 },
  { width: 1080, height: 1800 },
]) {
  test(`${viewport.width}×${viewport.height} のビューポートに、両者の盤面と手札が収まる`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.evaluate(() =>
      localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "混んだ局面" })),
    );
    await page.routeWebSocket(/\/ws\?/, (ws) => ws.send(JSON.stringify(crowdedSync(20))));
    await page.reload();
    await expect(page.locator("#self .zone.bench .card").first()).toBeVisible();

    const board = await visibleBoard(page, "#table");
    for (const side of ["#opponent", "#self"]) {
      for (const zone of ZONES)
        await expectInside(page, `${side} [data-zone="${zone}"] .card`, board);
    }
    await expectInside(page, '#stadium [data-zone="stadium"] .card', board);
    const screen = { x: 0, y: 0, ...viewport };
    for (const selector of ["#clock", "#concede-button", "#moves button >> nth=0", "#events"]) {
      await expectInside(page, selector, screen);
    }

    // 手札は枚数の見出しまで含めて、名前のために空けた幅の内側に収める。中身の見えない側も同じ。
    for (const side of ["#opponent", "#self"]) {
      const edges = await page.locator(`${side} [data-zone="hand"]`).evaluate((zone) => {
        // この tsconfig は DOM の型を読まないので、ページの側から引く。
        const style = Reflect.get(globalThis, "getComputedStyle") as (node: unknown) => {
          paddingRight: string;
        };
        return {
          label: zone.querySelector(".zone-label")!.getBoundingClientRect().right,
          inner: zone.getBoundingClientRect().right - parseFloat(style(zone).paddingRight),
        };
      });
      expect(edges.label, side).toBeLessThanOrEqual(edges.inner + 0.5);
    }

    // ベンチは狭くても折り返さない。
    for (const side of ["#opponent", "#self"]) {
      const benchTops = await page
        .locator(`${side} [data-zone="bench"] > .pokemon`)
        .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
      expect(benchTops).toHaveLength(5);
      expect(new Set(benchTops).size, side).toBe(1);
    }

    // 手札は多くても 1 段に並べ、重ねて収める。名前の上には重ねない。
    const hand = page.locator('#self [data-zone="hand"] .card');
    const tops = await hand.evaluateAll((nodes) =>
      nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
    );
    expect(tops).toHaveLength(20);
    expect(new Set(tops).size).toBe(1);
    const name = (await page.locator("#table .board-side:last-child > h2").boundingBox()) as Box;
    expect(overlaps(name, (await hand.first().boundingBox()) as Box)).toBe(false);
  });
}

test("観戦の画面でも、両者の盤面と時計が 1 画面に収まる", async ({ page }) => {
  const viewport = { width: 1920, height: 900 };
  await page.setViewportSize(viewport);
  const { view, clock } = crowdedSync(20) as {
    view: { self: { hand: unknown[] }; opponent: object; stadium: object };
    clock: object;
  };
  const { hand, ...shown } = view.self;
  await page.routeWebSocket(/\/ws\?/, (ws) =>
    ws.send(
      JSON.stringify({
        t: "spectator-sync",
        view: {
          ...view,
          viewer: "spectator",
          players: [{ ...shown, handCount: hand.length }, view.opponent],
        },
        seats: [
          { displayName: "長い名前を付けたプレイヤー".repeat(3), rating: 1500 },
          { displayName: "ななし", rating: 1500 },
        ],
        clock,
      }),
    ),
  );
  await page.goto("/?watch=観戦");
  await expect(page.locator("#watch-side-0 .zone.bench .card").first()).toBeVisible();

  const board = await visibleBoard(page, "#watch");
  for (const side of ["#watch-side-1", "#watch-side-0"]) {
    for (const zone of ZONES)
      await expectInside(page, `${side} [data-zone="${zone}"] .card`, board);
  }
  await expectInside(page, '#watch-stadium [data-zone="stadium"] .card', board);
  await expectInside(page, "#watch-clock", { x: 0, y: 0, ...viewport });
  // 長い名前は省いて、手札に重ねない。
  const name = (await page.locator("#watch-name-0").boundingBox()) as Box;
  const backs = (await page
    .locator('#watch-side-0 [data-zone="hand"] .card')
    .first()
    .boundingBox()) as Box;
  expect(overlaps(name, backs)).toBe(false);
});
