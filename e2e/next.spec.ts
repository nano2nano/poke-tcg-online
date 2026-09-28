/**
 * 新しい画面（`web/`）が、いまの画面と同じ Worker から配られていることを見る。
 * 中身は client.spec.ts を `/next/` へ向けて確かめる。ここでは入口が描けることと、いまの画面を置き換えていないことだけを見る。
 */

import { createHash } from "node:crypto";
import { expect, test, type Page, type WebSocket } from "@playwright/test";
import { loadGeneratedCards } from "../src/engine.js";
import type { Seated } from "../src/lobby.js";
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
  // `code` の無い断りはデッキの違反なので、違反はデッキの欄に出る。
  expect(await status.textContent()).toContain("デッキを直して");
  await expect(page.locator("#deck-status")).toContainText("断った");
});

/** 座席へ繋ぐ URL から、座席トークンと開いたシェアを読む。 */
async function openedSeat(socket: Promise<WebSocket>) {
  const url = new URL((await socket).url());
  return { seatToken: url.searchParams.get("seatToken"), share: url.searchParams.get("seedShare") };
}

function commitOf(share: string | null): string | null {
  return share === null ? null : createHash("sha256").update(`share:${share}`).digest("hex");
}

test("待っているあいだに席が決まってから押し直すと、あいだに届かなかった押し直しがあっても、その席へ前のシェアで着く", async ({
  page,
  browser,
}) => {
  // 待つあいだの取り直しでは席を渡さない。押し直したときに、サーバが返す席だけで着くようにする。
  await page.route("**/api/claim?**", (route) => route.fulfill({ json: { kind: "waiting" } }));
  const room = `きまっていた-${Date.now()}`;
  await page.goto(`${BASEPATH}/`);
  await page.fill("#room", room);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  const { ticket } = (await (await answered).json()) as { ticket: string };

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto(`${BASEPATH}/`);
    await opponent.fill("#room", room);
    const seated = opponent.waitForResponse((response) => response.url().endsWith("/api/join"));
    await opponent.click("#join-button");
    await seated;
    const claimed = await page.request.get(`/api/claim?ticket=${encodeURIComponent(ticket)}`);
    const { seat } = (await claimed.json()) as { seat: Seated };

    // サーバに届かなかったリクエストのシェアが、前のシェアを押し出さない。
    await page.route("**/api/join", (route) => route.abort(), { times: 1 });
    await page.click("#join-button");
    await expect(page.locator("#join-status")).toContainText("つながらなかった");

    // 席が決まったチケットは降ろすものが無い。サーバが 2 局目を始めると、この席は誰も座らないまま負けになる。
    const opened = openedSeat(page.waitForEvent("websocket"));
    await page.click("#join-button");
    const { seatToken, share } = await opened;
    expect(seatToken).toBe(seat.seatToken);
    expect(commitOf(share)).toBe(seat.seedShareCommits[seat.seat]);
  } finally {
    await other.close();
  }
});

test("返事の届かなかったリクエストで席が決まっていたら、押し直してその席へ着く", async ({
  page,
  browser,
}) => {
  const room = `とどかなかった-${Date.now()}`;
  // サーバには届けて、返事だけを落とす。画面はチケットを知らないまま、そのチケットで相手が決まる。
  let lost = true;
  await page.route("**/api/join", async (route) => {
    if (!lost) return route.continue();
    lost = false;
    await route.fetch();
    await route.abort();
  });
  await page.goto(`${BASEPATH}/`);
  await page.fill("#room", room);
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("つながらなかった");

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto(`${BASEPATH}/`);
    await opponent.fill("#room", room);
    const seated = opponent.waitForResponse((response) => response.url().endsWith("/api/join"));
    await opponent.click("#join-button");
    const outcome = (await (await seated).json()) as { seat: Seated };
    // 相手は座席 1 に座るので、こちらの席は座席 0 である。
    const commit = outcome.seat.seedShareCommits[0];
    // 組み直しかけで規則に通らないデッキでも、続いている対戦へは戻れる。
    await page.evaluate(() => {
      localStorage.setItem("poke-deck", JSON.stringify([{ defId: "組みかけ", count: 1 }]));
    });

    const opened = openedSeat(page.waitForEvent("websocket"));
    await page.click("#join-button");
    const { share } = await opened;
    expect(commitOf(share)).toBe(commit);
  } finally {
    await other.close();
  }
});

/** サンプルデッキの先頭のカードを、検索から 1 枚足す。 */
async function addFirstSampleCard(page: Page): Promise<string> {
  const deck = (await (await page.request.get("/api/sample-deck")).json()) as { cards: string[] };
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string; set?: string; number?: string }
  >;
  const defId = deck.cards[0] as string;
  const card = cards[defId] as { name: string; set?: string; number?: string };
  await page.fill("#card-search", [card.name, card.set, card.number].filter(Boolean).join(" "));
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).click();
  return defId;
}

test("確かめる返事を待つあいだに組み替えたら、その返事の結果を出さない", async ({ page }) => {
  await page.goto(`${BASEPATH}/`);
  const defId = await addFirstSampleCard(page);
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).click();
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/deck/validate", async (route) => {
    await held;
    await route.fulfill({ json: { ok: true, errors: [] } });
  });

  await page.click("#check-button");
  await page.locator(`#deck-cards .card-row[data-def-id="${defId}"] button.remove`).click();
  const answered = page.waitForResponse((response) =>
    response.url().endsWith("/api/deck/validate"),
  );
  release();
  await answered;
  // 確かめたのは 2 枚のデッキで、いまは 1 枚である。
  await expect(page.locator("#deck-cards .card-count")).toHaveText("1");
  await expect(page.locator("#deck-status")).not.toContainText("規則を通ります");
});

test("組み替える前に確かめた返事があとから届いても、組み替えてから確かめた結果を消さない", async ({
  page,
}) => {
  await page.goto(`${BASEPATH}/`);
  const defId = await addFirstSampleCard(page);
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  // どちらの検査も通ったことにする。1 度目の返事だけ、2 度目の結果が出たあとに届ける。
  await page.route("**/api/deck/validate", async (route) => {
    calls += 1;
    if (calls === 1) await held;
    await route.fulfill({ json: { ok: true, errors: [] } });
  });

  await page.click("#check-button");
  await page.locator(`#deck-cards .card-row[data-def-id="${defId}"] button.add`).click();
  await page.click("#check-button");
  await expect(page.locator("#deck-status")).toContainText("デッキは 2 枚で、規則を通ります");
  const late = page.waitForResponse((response) => response.url().endsWith("/api/deck/validate"));
  release();
  await late;
  // 返事が届いてから欄に書くまでを待つ。待たないと、書く前の欄を見て通ってしまう。
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await expect(page.locator("#deck-status")).toContainText("デッキは 2 枚で、規則を通ります");
});

/** 公式のカード ID のうち、このサーバで複数のカードに当たるもの。読み込むと、どれかを選ぶ欄が出る。 */
function sharedCardId(): string {
  const byCardId = new Map<string, string[]>();
  for (const def of loadGeneratedCards()) {
    for (const print of def.prints) {
      byCardId.set(print.cardID, [...(byCardId.get(print.cardID) ?? []), def.defId]);
    }
  }
  const [cardId] = [...byCardId].find(([, defIds]) => defIds.length > 1) as [string, string[]];
  return cardId;
}

test("公式のデッキコードで選んでいる途中に対戦をさがしても、選ぶ欄を残す", async ({ page }) => {
  const cardId = sharedCardId();
  await page.route("https://www.pokemon-card.com/deck/confirm.html/deckID/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: `<!DOCTYPE html><form><input type="hidden" id="deck_sta" value="${cardId}_2_1" /></form>`,
    }),
  );
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, errors: ["デッキは 60 枚にしてください"] } }),
  );

  await page.goto(`${BASEPATH}/`);
  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  const choices = page.locator("#deck-status .choices button");
  await expect(choices.first()).toBeVisible();
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await joined;
  await expect(page.locator("#join-status")).toContainText("デッキを直して");
  await expect(page.locator("#deck-status")).toContainText("あと 2 枚を選んでください");
  await expect(page.locator("#deck-status")).toContainText("デッキは 60 枚にしてください");
  await choices.first().click();
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
});

test("公式のデッキコードで選んでいる途中でも、別のタブで組み替えたら、対戦をさがして断られた理由を出す", async ({
  page,
}) => {
  const cardId = sharedCardId();
  await page.route("https://www.pokemon-card.com/deck/confirm.html/deckID/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: `<!DOCTYPE html><form><input type="hidden" id="deck_sta" value="${cardId}_2_1" /></form>`,
    }),
  );
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, errors: ["デッキは 60 枚にしてください"] } }),
  );

  await page.goto(`${BASEPATH}/`);
  const defId = await addFirstSampleCard(page);
  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.click("#deck-code-button");
  await expect(page.locator("#deck-status .choices button").first()).toBeVisible();

  const other = await page.context().newPage();
  await other.goto(page.url());
  await other.evaluate(
    (card) => localStorage.setItem("poke-deck", JSON.stringify([{ defId: card, count: 1 }])),
    defId,
  );
  await other.close();
  await expect(page.locator("#deck-status .choices button")).toHaveCount(0);
  await page.click("#join-button");
  await expect(page.locator("#deck-status")).toContainText("デッキは 60 枚にしてください");
});

test("対戦をさがす返事を待つあいだに最後の 1 枚を選んだら、選び終えたデッキを確かめた結果を出す", async ({
  page,
}) => {
  const cardId = sharedCardId();
  await page.route("https://www.pokemon-card.com/deck/confirm.html/deckID/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: `<!DOCTYPE html><form><input type="hidden" id="deck_sta" value="${cardId}_1_1" /></form>`,
    }),
  );
  // 1 枚のデッキは規則に通らない。通ったことにして、その結果が残るのを見る。
  await page.route("**/api/deck/validate", (route) =>
    route.fulfill({ json: { ok: true, errors: [] } }),
  );
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/join", async (route) => {
    await held;
    await route.fulfill({ json: { ok: false, errors: ["選ぶ前のデッキの理由"] } });
  });

  await page.goto(`${BASEPATH}/`);
  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.locator("#deck-status .choices button").first().waitFor();
  await page.click("#join-button");
  await page.locator("#deck-status .choices button").first().click();
  await expect(page.locator("#deck-status")).toContainText("規則を通ります");
  release();
  await joined;
  await expect(page.locator("#join-status")).toContainText("デッキが変わりました");
  await expect(page.locator("#deck-status")).toContainText("規則を通ります");
  await expect(page.locator("#deck-status")).not.toContainText("選ぶ前のデッキの理由");
});

test("対戦をさがす返事を待つあいだに組み替えたら、断られた理由を出さない", async ({ page }) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/join", async (route) => {
    await held;
    await route.fulfill({ json: { ok: false, errors: ["デッキは 60 枚にしてください"] } });
  });

  await page.goto(`${BASEPATH}/`);
  await addFirstSampleCard(page);
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await page.locator("#deck-cards .card-row button.add").first().click();
  release();
  await joined;
  await expect(page.locator("#join-status")).toContainText("デッキが変わりました");
  await expect(page.locator("#deck-status")).not.toContainText("60 枚にしてください");
});

test("デッキを確かめた結果は、対戦をさがしても残す", async ({ page }) => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/join", async (route) => {
    await held;
    await route.fulfill({ json: { ok: false, code: "account-not-found", errors: ["断った"] } });
  });
  // 1 枚のデッキは規則に通らない。通ったことにして、その結果が残るのを見る。
  await page.route("**/api/deck/validate", (route) =>
    route.fulfill({ json: { ok: true, errors: [] } }),
  );

  await page.goto(`${BASEPATH}/`);
  await addFirstSampleCard(page);
  await page.click("#check-button");
  await expect(page.locator("#deck-status")).toContainText("規則を通ります");
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("デッキを送っています");
  release();
  await joined;
  await expect(page.locator("#join-status")).toContainText("断った");
  await expect(page.locator("#deck-status")).toContainText("規則を通ります");
});

test("サンプルデッキを使うと出たあとに別のタブでデッキを組んだら、その文を消す", async ({
  page,
}) => {
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, code: "account-not-found", errors: ["断った"] } }),
  );
  await page.goto(`${BASEPATH}/`);
  const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await joined;
  await expect(page.locator("#deck-status")).toContainText("サンプルデッキを使います");

  const other = await page.context().newPage();
  await other.goto(page.url());
  const defId = await addFirstSampleCard(other);
  await other.close();
  await expect(page.locator(`#deck-cards .card-row[data-def-id="${defId}"]`)).toHaveCount(1);
  await expect(page.locator("#deck-status")).not.toContainText("サンプルデッキを使います");
});

test("最後の 1 枚を選んだあとの確かめに失敗したら、その失敗を出す", async ({ page }) => {
  const cardId = sharedCardId();
  await page.route("https://www.pokemon-card.com/deck/confirm.html/deckID/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=UTF-8",
      headers: { "access-control-allow-origin": "*" },
      body: `<!DOCTYPE html><form><input type="hidden" id="deck_sta" value="${cardId}_1_1" /></form>`,
    }),
  );
  await page.route("**/api/deck/validate", (route) => route.abort());

  await page.goto(`${BASEPATH}/`);
  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  await page.locator("#deck-status .choices button").first().click();
  await expect(page.locator("#deck-status")).toContainText("確かめられませんでした");
});

test("画像を読めなかったカードは、候補の行に小さな面を残さない", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", (route) => route.fulfill({ status: 502, body: "" }));
  await page.goto(`${BASEPATH}/`);
  await page.fill("#card-search", "エネルギー");
  await expect(page.locator("#card-results .card-row").first()).toBeVisible();
  await expect(page.locator("#card-results .card.thumb")).toHaveCount(0);
});
