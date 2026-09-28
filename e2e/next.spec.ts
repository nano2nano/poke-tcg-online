/**
 * 新しい画面（`web/`）が、いまの画面と同じ Worker から配られていることを見る。
 * 中身は client.spec.ts を `/next/` へ向けて確かめる。ここでは入口が描けることと、いまの画面を置き換えていないことだけを見る。
 */

import { expect, test } from "@playwright/test";
import { BASEPATH } from "../web/basepath.js";

test("新しい画面は /next/ で描け、いまの画面は / に残る", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto(`${BASEPATH}/`);
  await expect(page.locator("#next-home")).toBeVisible();
  await expect(page.locator("#join")).toBeVisible();

  await page.goto("/");
  await expect(page.locator("#join")).toBeVisible();
  await expect(page.locator("#next-home")).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("相手さがしを頼んでいるあいだは、「対戦をさがす」を押し直せない", async ({ page }) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/join", async (route) => {
    await held;
    await route.continue();
  });

  await page.goto(`${BASEPATH}/`);
  await page.fill("#room", `おしなおし-${Date.now()}`);
  await page.click("#join-button");
  // 先のリクエストで席が決まると、あとのリクエストがキューに残り、誰も開かない席として組まれる。
  await expect(page.locator("#join-button")).toBeDisabled();

  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  release();
  await answered;
  // 相手を待っているあいだは押し直せる。サーバが前のチケットを降ろす。
  await expect(page.locator("#join-button")).toBeEnabled();
});

test("繋がらずにロビーへ戻っても、覚えている座席へ戻れる", async ({ page }) => {
  let opened = 0;
  await page.routeWebSocket(
    (url) => url.searchParams.has("seatToken"),
    (socket) => {
      opened += 1;
      void socket.close();
    },
  );
  await page.addInitScript(() => {
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つながらない座席" }));
  });

  await page.goto(`${BASEPATH}/`);
  // 新しく対戦に入ると、この座席を置き換える。
  await expect(page.locator("#resume-button")).toBeVisible();
  expect(opened).toBe(1);

  // 相手さがしの答えを待つあいだに戻ると、その答えが戻った座席を置き換える。
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/join", async (route) => {
    await held;
    await route.fulfill({ json: { ok: false, errors: ["断った"] } });
  });
  await page.click("#join-button");
  await expect(page.locator("#resume-button")).toBeDisabled();
  release();
  await expect(page.locator("#resume-button")).toBeEnabled();

  // 離れてから別のタブが新しい対戦の座席を置いた。戻っても、そちらを消さない。
  await page.evaluate(() => {
    localStorage.setItem("poke-seat", JSON.stringify({ seat: 1, seatToken: "別のタブの座席" }));
  });
  await page.click("#resume-button");
  await expect.poll(() => opened).toBe(2);
  const stored = await page.evaluate(() => localStorage.getItem("poke-seat"));
  expect(JSON.parse(stored ?? "null")).toMatchObject({ seatToken: "別のタブの座席" });
});

test("離れるあいだに別のタブが座席を置いていても、戻る先は離れた座席である", async ({ page }) => {
  const tokens: (string | null)[] = [];
  await page.routeWebSocket(
    (url) => url.searchParams.has("seatToken"),
    async (socket) => {
      tokens.push(new URL(socket.url()).searchParams.get("seatToken"));
      await page.evaluate(() => {
        localStorage.setItem("poke-seat", JSON.stringify({ seat: 1, seatToken: "別のタブの座席" }));
      });
      void socket.close();
    },
  );
  await page.addInitScript(() => {
    if (localStorage.getItem("poke-seat") === null) {
      localStorage.setItem("poke-seat", JSON.stringify({ seat: 0, seatToken: "つながらない座席" }));
    }
  });

  await page.goto(`${BASEPATH}/`);
  await page.click("#resume-button");
  // 別のタブの座席へ繋ぐと、そのタブの接続を追い出す。
  await expect.poll(() => tokens).toEqual(["つながらない座席", "つながらない座席"]);
  // 戻った座席へもう一度繋がらなくても、戻る道は残る。
  await expect(page.locator("#resume-button")).toBeVisible();
});

test("相手を待つあいだに押し直して断られても、前のチケットを待ち続ける", async ({ page }) => {
  const claimed = () => page.waitForResponse((response) => response.url().includes("/api/claim?"));
  const status = page.locator("#join-status");

  await page.goto(`${BASEPATH}/`);
  await page.fill("#room", `まちつづける-${Date.now()}`);
  const first = claimed();
  await page.click("#join-button");
  await first;
  // 2 度目を取りに行くのは 1 度目の答えを出したあとなので、出ているのは待っている一言である。
  await claimed();
  const waiting = await status.textContent();

  // サーバが前のチケットを降ろすのは、新しいリクエストを受け付けたときだけである。
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, errors: ["断った"] } }),
  );
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await refused;
  await expect(status).not.toHaveText(waiting ?? "");

  // 待ち続けても、断られた理由を待っている一言で消さない。2 度目の答えは 1 度目の答えを出したあとに届く。
  await claimed();
  await claimed();
  expect(await status.textContent()).toContain("断った");
});

test("押し直す前に前のチケットで席が決まっていたら、その席に着いて頼み直さない", async ({
  page,
}) => {
  // 待つあいだの取り直しを止め、押し直すときの 1 回だけが席を取りに行くようにする。
  await page.clock.install();
  let seated = false;
  await page.route("**/api/claim?**", (route) =>
    route.fulfill({
      json: seated
        ? {
            kind: "seated",
            seat: {
              matchId: "決まった対戦",
              seat: 0,
              seatToken: "決まった座席",
              seedCommit: "",
              seedShareCommits: [null, null],
            },
          }
        : { kind: "waiting" },
    }),
  );
  const joins: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/join")) joins.push(request.url());
  });

  await page.goto(`${BASEPATH}/`);
  await page.fill("#room", `きまっていた-${Date.now()}`);
  const first = page.waitForResponse((response) => response.url().includes("/api/claim?"));
  await page.click("#join-button");
  await first;

  // サーバは席が決まったチケットを降ろさないので、頼み直すと 2 局を抱える。
  seated = true;
  const opened = page.waitForEvent("websocket");
  await page.click("#join-button");
  expect(new URL((await opened).url()).searchParams.get("seatToken")).toBe("決まった座席");
  expect(joins).toHaveLength(1);
});
