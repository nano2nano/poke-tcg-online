/** 画面（`web/`）のテストの続き。1 つのファイルが長くなりすぎないよう、`client.spec.ts` から分けている。 */

import { createHash } from "node:crypto";
import { expect, test, type Page, type WebSocket } from "@playwright/test";
import type { Bot } from "../src/bots.js";
import { legalMoves, loadGeneratedCards, type Player, type PlayerView } from "../src/engine.js";
import { MatchHub } from "../src/hub.js";
import type { Seated } from "../src/lobby.js";
import { concede, createMatch, submitMove, toMove, viewFor } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, legalDecks, newMatch } from "../tests/helpers.js";

test("画面を開くとロビーが描け、アセットに無いパスでも画面の骨組みが返る", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto("/");
  await expect(page.locator("#home")).toBeVisible();
  await expect(page.locator("#join")).toBeVisible();

  // アセットに無いパスにも、画面の骨組みを返す（`wrangler.jsonc` の `not_found_handling`）。
  const response = await page.request.get("/no-such-page");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("<title>");

  expect(errors).toEqual([]);
});

test("画面を入れ替える前に `/next/` で配った観戦のリンクは、`/` で開き直す", async ({ page }) => {
  await page.goto("/next/?watch=e2e-old-link");
  await expect(page).toHaveURL(/\/\?watch=e2e-old-link$/);
  await expect(page.locator("#watch")).toBeVisible();
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

  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
  await page.click("#resume-button");
  // 別のタブの座席へ繋ぐと、そのタブの接続を追い出す。
  await expect.poll(() => tokens).toEqual(["つながらない座席", "つながらない座席"]);
  // 戻った座席へもう一度繋がらなくても、戻る道は残る。
  await expect(page.locator("#resume-button")).toBeVisible();
});

test("相手を待つあいだに押し直して断られても、前のチケットを待ち続ける", async ({ page }) => {
  const claimed = () => page.waitForResponse((response) => response.url().includes("/api/claim?"));
  const status = page.locator("#join-status");

  await page.goto("/");
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
  await page.goto("/");
  await page.fill("#room", room);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  const { ticket } = (await (await answered).json()) as { ticket: string };

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto("/");
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
  await page.goto("/");
  await page.fill("#room", room);
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("つながらなかった");

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto("/");
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
  await page.goto("/");
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
  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
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

  await page.goto("/");
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
  await page.goto("/");
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

  await page.goto("/");
  await page.fill("#deck-code", "abc123-DEF456-ghi789");
  await page.click("#deck-code-button");
  await page.locator("#deck-status .choices button").first().click();
  await expect(page.locator("#deck-status")).toContainText("確かめられませんでした");
});

test("デッキを確かめるのに失敗したら、その失敗を出す", async ({ page }) => {
  await page.route("**/api/deck/validate", (route) => route.abort());
  await page.goto("/");
  await addFirstSampleCard(page);
  await page.click("#check-button");
  await expect(page.locator("#deck-status")).toContainText("確かめられませんでした");
});

test("画像を読めなかったカードは、候補の行に小さな面を残さない", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", (route) => route.fulfill({ status: 502, body: "" }));
  await page.goto("/");
  await page.fill("#card-search", "エネルギー");
  await expect(page.locator("#card-results .card-row").first()).toBeVisible();
  await expect(page.locator("#card-results .card.thumb")).toHaveCount(0);
});

/**
 * `loading="lazy"` の画像は、隠れているあいだは頼まずに待つ。候補の一覧を隠しておき、デッキの行で
 * 同じ画像が読めなかったと分かったら、一覧のカードも頼まずに画像を外すことを確かめる。
 */
test("読めなかった画像は、隠れて待っていた同じカードでも頼み直さない", async ({ page }) => {
  const asked: string[] = [];
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 502, body: "" });
  });
  await page.goto("/");
  const hiding = await page.addStyleTag({ content: "#card-results { display: none; }" });
  await page.fill("#card-search", "エネルギー");
  const row = page.locator("#card-results .card-row").last();
  await expect(row.locator("img")).toHaveCount(1);
  const defId = (await row.getAttribute("data-def-id")) as string;
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { cardID?: string }
  >;
  const path = `/api/card-image/${cards[defId]?.cardID}`;
  expect(asked).not.toContain(path);

  await row.locator("button.add").dispatchEvent("click");
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
  await expect.poll(() => asked).toContain(path);
  await expect(page.locator("#deck-cards .card-row .card")).toHaveCount(0);

  await hiding.evaluate((style) => (style as HTMLStyleElement).remove());
  await expect(row).toBeVisible();
  await expect(row.locator(".card")).toHaveCount(0);
  expect(asked.filter((each) => each === path)).toHaveLength(1);
});

/** サーバがプレイヤーを忘れていたときの答え。 */
const accountMissing = {
  status: 404,
  json: { error: "アカウントが見つからない", code: "account-not-found" },
};

let openingViews: PlayerView[] | null = null;

/** リプレイの答えに載せる盤面。どのテストでも開始局面で足りるので、1 度だけ作る。 */
function opening(): PlayerView[] {
  if (openingViews === null) {
    ensureCards();
    const match = newMatch("next-history");
    openingViews = [viewFor(match, 0), viewFor(match, 1)];
  }
  return openingViews;
}

/** 一覧とリプレイの答えを差し替える。盤面は `viewsFor` がなければ開始局面のまま、手数だけを返す。 */
async function mockHistory(
  page: Page,
  frameFor: (matchId: string, ply: number) => Promise<"fail" | "ok">,
  /** 再現できない地点。サーバと同じく、その先を頼まれたときだけ知らせる。 */
  diverged: number | null = null,
  viewsFor: (ply: number) => PlayerView[] = opening,
): Promise<void> {
  const summary = (matchId: string, opponentName: string) => ({
    matchId,
    startedAt: "2026-09-28T00:00:00Z",
    endedAt: "2026-09-28T00:10:00Z",
    seat: 0,
    opponentName,
    outcome: "win",
    matchResult: { kind: "concede", winner: 0, conceded: 1 },
    moveCount: 10,
  });
  await page.route("**/api/matches", (route) =>
    route.fulfill({ json: { matches: [summary("a", "あ"), summary("b", "い")] } }),
  );
  await page.route("**/api/replay", async (route) => {
    const { matchId, ply } = route.request().postDataJSON() as { matchId: string; ply: number };
    if ((await frameFor(matchId, ply)) === "fail") {
      return route.fulfill({ status: 503, json: { error: "落とした" } });
    }
    const beyond = diverged !== null && ply > diverged;
    return route.fulfill({
      json: {
        frame: {
          matchId,
          ply: beyond ? diverged : ply,
          moveCount: 10,
          views: viewsFor(beyond ? diverged : ply),
          playedMove: null,
          beforeViews: null,
          events: [[], []],
          engineCommitDiffers: false,
          divergedAt: beyond ? diverged : null,
        },
      },
    });
  });
}

/** 見出しの手数。「10 / 10 手」を 0 手目と取り違えない。 */
const atPly = (ply: number) => new RegExp(`(^|[^0-9])${ply} / 10 手`);

/** 答えを受けてから描き直すまでを待つ。 */
async function painted(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

function gate(): [Promise<void>, () => void] {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return [promise, release];
}

/** リプレイを開いて、盤面の手札のカードを返す。 */
async function replayHand(page: Page) {
  await mockHistory(page, async () => "ok");
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  const hand = page.locator('#replay [data-zone="hand"] .card[data-def-id]');
  await expect(hand.first()).toBeVisible();
  return hand;
}

/** 自分のたねポケモンを手札からバトル場へ出す前と後の、両座席の局面。 */
function placingActive(): [PlayerView[], PlayerView[]] {
  ensureCards();
  const match = newMatch("motion-place");
  const views = () => [viewFor(match, 0), viewFor(match, 1)];
  while (match.state.phase === "setup") {
    const before = views();
    const mover = toMove(match) as Player;
    expect(submitMove(match, mover, match.version, legalMoves(match.state)[0]!, 0).ok).toBe(true);
    if (viewFor(match, 0).self.active !== null) return [before, views()];
  }
  throw new Error("バトル場にポケモンを出さないまま準備が終わった");
}

/**
 * リプレイを開き、`frames` の最初の局面を描いたところで時計を止める。1 手進めるごとに次の局面を描く。
 * 返すのは、自分のバトル場に出たカードと、それがその枠に収まっているかを調べる関数。
 */
async function openPlacing(page: Page, ...frames: PlayerView[][]) {
  await page.clock.install();
  await mockHistory(
    page,
    async () => "ok",
    null,
    (ply) => frames[Math.min(ply, frames.length - 1)]!,
  );
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  const zone = page.locator('#replay-self [data-zone="active"]');
  await expect(page.locator('#replay-self [data-zone="hand"] .card').first()).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);

  const card = zone.locator(".card[data-def-id]");
  const inZone = async (): Promise<boolean> => {
    const [box, area] = [await card.boundingBox(), await zone.boundingBox()];
    if (box === null || area === null) return false;
    const middle = box.y + box.height / 2;
    return middle >= area.y && middle <= area.y + area.height;
  };
  return { card, inZone };
}

test("手札のカードを場に出すと、手札の位置から動いて場に収まる", async ({ page }) => {
  const [before, after] = placingActive();
  const { card, inZone } = await openPlacing(page, before, after);
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  // 動き始めは、手札にあった位置に描く。
  await page.clock.runFor(20);
  expect(await inZone()).toBe(false);
  await expect(card).toHaveAttribute("data-moving");
  // 出ていくカードは、詰めて動く手札より上に描く。
  const zIndex = (node: Element) => getComputedStyle(node).zIndex;
  expect(await card.evaluate(zIndex)).toBe("3");
  const shifting = page.locator('#replay-self [data-zone="hand"] .card[data-moving]');
  await expect(shifting.first()).toBeAttached();
  expect(await shifting.first().evaluate(zIndex)).toBe("auto");
  await page.clock.runFor(1_000);
  expect(await inZone()).toBe(true);
  await expect(card).not.toHaveAttribute("data-moving");
});

test("動いている途中で画面の幅が変わっても、動き終えた印を付ける", async ({ page }) => {
  const [before, after] = placingActive();
  const { card } = await openPlacing(page, before, after);
  await page.click("#replay-next");
  await page.clock.runFor(20);
  await expect(card).toHaveAttribute("data-moving");
  // 幅が変わると、Motion は動きを途中で打ち切る。
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width - 40, height: size.height });
  await page.clock.runFor(1_000);
  await expect(card).not.toHaveAttribute("data-moving");
});

test("ベンチへ下がるポケモンは、ダメージの印も一緒に動く", async ({ page }) => {
  const [, placed] = placingActive();
  const damaged = structuredClone(placed);
  const active = damaged[0]!.self.active;
  if (active === null || "concealed" in active) throw new Error("バトル場にポケモンがいない");
  active.damage = 60;
  const benched = structuredClone(damaged);
  benched[0]!.self.bench = [benched[0]!.self.active];
  benched[0]!.self.active = null;
  await openPlacing(page, damaged, benched);
  await page.click("#replay-next");
  const pokemon = page.locator('#replay-self [data-zone="bench"] .pokemon');
  await expect(pokemon).toBeVisible();
  await page.clock.runFor(20);
  const [card, badge] = [
    await pokemon.locator(".card").boundingBox(),
    await pokemon.locator(".damage").boundingBox(),
  ];
  if (card === null || badge === null) throw new Error("カードか印が描けていない");
  const middle = { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 };
  expect(middle.x).toBeGreaterThan(card.x);
  expect(middle.x).toBeLessThan(card.x + card.width);
  expect(middle.y).toBeGreaterThan(card.y);
  expect(middle.y).toBeLessThan(card.y + card.height);
});

/** バトル場のポケモンに、ダメージを載せて別の ID を付けた写し。ベンチに並べる 2 匹目にする。 */
function anotherPokemon(views: PlayerView[], damage: number) {
  const active = views[0]!.self.active;
  if (active === null || "concealed" in active) throw new Error("バトル場にポケモンがいない");
  const copy = structuredClone(active);
  copy.inPlayId += "-2";
  for (const card of copy.stack) card.instanceId += "-2";
  copy.damage = damage;
  return { active, copy };
}

test("バトル場とベンチが入れ替わると、ベンチから出たポケモンも印ごと動く", async ({ page }) => {
  const [, placed] = placingActive();
  const before = structuredClone(placed);
  const { active, copy } = anotherPokemon(before, 30);
  before[0]!.self.bench = [copy];
  const after = structuredClone(before);
  after[0]!.self.active = structuredClone(copy);
  after[0]!.self.bench = [structuredClone(active)];
  await openPlacing(page, before, after);
  await page.click("#replay-next");
  const pokemon = page.locator('#replay-self [data-zone="active"] .pokemon');
  await expect(pokemon).toHaveAttribute("data-damage", "30");
  await page.clock.runFor(20);
  const [card, badge] = [
    await pokemon.locator(".card").boundingBox(),
    await pokemon.locator(".damage").boundingBox(),
  ];
  if (card === null || badge === null) throw new Error("カードか印が描けていない");
  await page.clock.runFor(1_000);
  const middle = { x: badge.x + badge.width / 2, y: badge.y + badge.height / 2 };
  expect(middle.x).toBeGreaterThan(card.x);
  expect(middle.x).toBeLessThan(card.x + card.width);
  expect(middle.y).toBeGreaterThan(card.y);
  expect(middle.y).toBeLessThan(card.y + card.height);
  expect(await pokemon.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
});

test("何手か前に見えていたカードが出てきても、前の場所からは動かさない", async ({ page }) => {
  const [before, placed] = placingActive();
  // Motion は、消えたカードの最後の位置を、次に同じ layoutId のカードが出てきたときまで持ち越さない。
  // 持ち越すようになったら、前の局面で描いていなかったカードには別の layoutId を付ける。
  // 出したカードをいったん盤面から消し（山札へもどしたことにする）、次の手でまた場に出す。
  const hidden = structuredClone(placed);
  hidden[0]!.self.active = null;
  const { inZone, card } = await openPlacing(page, before, hidden, placed);
  await page.click("#replay-next");
  await expect(card).toHaveCount(0);
  await page.clock.runFor(1_000);
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  await page.clock.runFor(20);
  expect(await inZone()).toBe(true);
});

test("場から手札へもどるカードも、ほかのカードの上に描く", async ({ page }) => {
  const [, placed] = placingActive();
  const back = structuredClone(placed);
  const active = back[0]!.self.active;
  if (active === null || "concealed" in active || !("hand" in back[0]!.self)) {
    throw new Error("バトル場にポケモンがいないか、手札が見えない");
  }
  back[0]!.self.hand.push(...active.stack.map((card) => ({ ...card, identified: false })));
  back[0]!.self.active = null;
  await openPlacing(page, placed, back);
  await page.click("#replay-next");
  const card = page.locator('#replay-self [data-zone="hand"] .card[data-def-id]').last();
  await page.clock.runFor(20);
  await expect(card).toHaveAttribute("data-moving", "arriving");
  expect(await card.evaluate((node) => getComputedStyle(node).zIndex)).toBe("3");
});

test("OS で動きを減らす設定にしていたら、カードを動かさずに場に置く", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [before, after] = placingActive();
  const { card, inZone } = await openPlacing(page, before, after);
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  await page.clock.runFor(20);
  expect(await inZone()).toBe(true);
});

test("ねむりのポケモンは、カードを左へ倒して描く", async ({ page }) => {
  const [before, after] = placingActive();
  const asleep = structuredClone(after);
  const active = asleep[0]!.self.active;
  if (active === null || "concealed" in active) throw new Error("バトル場にポケモンがいない");
  active.conditions = [{ kind: "asleep" }] as typeof active.conditions;
  const { card } = await openPlacing(page, before, asleep);
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  await page.clock.runFor(1_000);
  // 左へ 90 度倒すと、変換の行列は (0, -1, 1, 0) になる。
  const matrix = await card.evaluate((node) => getComputedStyle(node).transform);
  expect(matrix).toMatch(/^matrix\(0, -1, 1, 0, /);
});

test("載せているカードが別のカードに描き替わったら、プレビューも替える", async ({ page }) => {
  const hand = await replayHand(page);
  const preview = page.locator("#card-preview");
  await hand.first().hover();
  await expect(preview).toBeVisible();
  const other = await page.evaluate(
    (shown) =>
      [...document.querySelectorAll<HTMLElement>("#replay .card[data-def-id]")]
        .map((card) => card.dataset.defId)
        .find((defId) => defId !== shown),
    await hand.first().getAttribute("data-def-id"),
  );
  if (other === undefined) throw new Error("盤面に別のカードが無い");

  // 同じ位置の要素のまま中身だけ替わる描き直しと同じにする。
  await hand.first().evaluate((node, defId) => {
    if (node instanceof HTMLElement) node.dataset.defId = defId;
  }, other);
  await expect(preview.locator(".card")).toHaveAttribute("data-def-id", other);
});

test("載せているカードが描き直しで少し動いたら、プレビューも付いていく", async ({ page }) => {
  const hand = await replayHand(page);
  const preview = page.locator("#card-preview");
  const card = hand.first();
  await card.hover();
  await expect(preview).toBeVisible();
  const offset = async (): Promise<number> =>
    ((await preview.boundingBox())?.y ?? 0) - ((await card.boundingBox())?.y ?? 0);
  const before = await offset();
  const top = (await card.boundingBox())?.y ?? 0;

  // 描き直しでカードが少し下へずれる。マウスの下は同じカードのままなので、載せ直しの合図は来ない。
  await card.evaluate((node) => {
    if (node instanceof HTMLElement) node.style.translate = "0 6px";
    document.body.append(document.createElement("div"));
  });
  expect((await card.boundingBox())?.y).toBeCloseTo(top + 6, 0);
  await expect.poll(offset).toBeCloseTo(before, 0);
});

test("載せているカードが動き終えたら、収まった位置でプレビューを置き直す", async ({ page }) => {
  const hand = await replayHand(page);
  const preview = page.locator("#card-preview");
  const card = hand.first();
  await card.hover();
  await expect(preview).toBeVisible();
  const offset = async (): Promise<number> =>
    ((await preview.boundingBox())?.y ?? 0) - ((await card.boundingBox())?.y ?? 0);
  const before = await offset();

  // 動いているあいだは位置が決まらないので、動き終えた合図（`data-moving` を外す）で置き直す。
  await card.evaluate((node) => node.setAttribute("data-moving", ""));
  await card.evaluate((node) => {
    if (node instanceof HTMLElement) node.style.translate = "0 6px";
  });
  await card.evaluate((node) => node.removeAttribute("data-moving"));
  await expect.poll(offset).toBeCloseTo(before, 0);
});

test("載せているあいだに画面が低くなっても、プレビューを画面に収める", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  // 返さない。読み込んでいるあいだも、候補の行には小さな面が出る。
  await page.route("**/api/card-image/*", () => {});
  await page.goto("/");
  await page.fill("#card-search", "エネルギー");
  const add = page.locator("#card-results .card-row button.add");
  for (let i = 0; i < 3; i++) await add.nth(i).click();
  const card = page.locator("#deck-cards .card-row .card").last();
  const preview = page.locator("#card-preview");
  await card.hover();
  await expect(preview).toBeVisible();

  // カードは見えたまま、プレビューの下端より低くする。
  const under = await card.boundingBox();
  const shown = await preview.boundingBox();
  if (under === null || shown === null) throw new Error("カードかプレビューが出ていない");
  const height = Math.ceil(under.y + under.height) + 20;
  expect(shown.y + shown.height).toBeGreaterThan(height);
  await page.setViewportSize({ width: 1280, height });
  await expect
    .poll(async () => {
      const box = await preview.boundingBox();
      return box === null ? Infinity : box.y + box.height;
    })
    .toBeLessThanOrEqual(height);
});

test("拡大の中と背景にまたがって押しても、閉じない", async ({ page }) => {
  const hand = await replayHand(page);
  const zoom = page.locator("#card-zoom");
  await hand.first().click();
  await expect(zoom).toBeVisible();

  // 説明の文字を選ぼうとして、枠の外まで引っぱる。
  const title = await page.locator("#card-zoom-title").boundingBox();
  if (title === null) throw new Error("見出しが出ていない");
  await page.mouse.move(title.x + 2, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await expect(zoom).toBeVisible();
  // 逆に、背景で押し始めて中で離しても閉じない。
  await page.mouse.down();
  await page.mouse.move(title.x + 2, title.y + title.height / 2);
  await page.mouse.up();
  await expect(zoom).toBeVisible();

  await page.mouse.click(2, 2);
  await expect(zoom).toBeHidden();
});

test("拡大の中身が長くて出たスクロールバーを押しても、閉じない", async ({ page }) => {
  const hand = await replayHand(page);
  // カード 1 枚でも収まらない高さにする。
  await page.setViewportSize({ width: 1280, height: 240 });
  await hand.first().click();
  const zoom = page.locator("#card-zoom");
  await expect(zoom).toBeVisible();
  const scrolls = await zoom.evaluate((node) => node.scrollHeight > node.clientHeight);
  expect(scrolls).toBe(true);
  const box = await zoom.boundingBox();
  if (box === null) throw new Error("拡大が出ていない");
  // 縦のスクロールバーは右端の内側にある。
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await expect(zoom).toBeVisible();
});

test("キーボードで開いたキーを押し続けても、拡大を開いたままにする", async ({ page }) => {
  const hand = await replayHand(page);
  await hand.first().focus();
  // 押したままのあいだ、くり返しの keydown が届く。
  for (let i = 0; i < 3; i++) await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(page.locator("#card-zoom")).toBeVisible();

  // 「閉じる」で押し続けても、閉じたあとに戻ったカードで開き直さない。
  await page.locator("#card-zoom-close").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(page.locator("#card-zoom")).toBeHidden();
});

test.describe("タッチ端末", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("長押しを指をずらしてやめたら、次にキーボードで押したボタンを止めない", async ({ page }) => {
    await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
    // 返さない。読み込んでいるあいだも、候補の行には小さな面が出る。
    await page.route("**/api/card-image/*", () => {});
    await page.goto("/");
    await page.fill("#card-search", "エネルギー");
    const thumb = page.locator("#card-results .card-row .card").first();
    await expect(thumb).toBeVisible();
    const box = await thumb.boundingBox();
    if (box === null) throw new Error("小さな面が出ていない");

    // Playwright の `tap` は置いてすぐ離すので、CDP で指を置く。
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(page.locator("#card-preview")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: point.x, y: point.y + 30 }],
    });
    await expect(page.locator("#card-preview")).toBeHidden();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await page.locator("#card-results .card-row button.add").first().press("Enter");
    await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
  });
});

test("載せているあいだに画像が読めなかったと分かったら、プレビューに説明を書き添える", async ({
  page,
}) => {
  const [held, release] = gate();
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", async (route) => {
    await held;
    await route.fulfill({ status: 502, body: "" });
  });
  const hand = await replayHand(page);
  const preview = page.locator("#card-preview");
  await hand.first().hover();
  await expect(preview).toBeVisible();
  await expect(preview.locator("p")).toHaveCount(0);

  release();
  await expect(preview.locator("p")).toBeVisible();
  await expect(preview.locator("p")).not.toBeEmpty();
});

test("閉じて別の対戦を開いたあとに、閉じた対戦を開けなかった答えが届いても、開いている方を閉じない", async ({
  page,
}) => {
  const [slow, release] = gate();
  await mockHistory(page, async (matchId) => {
    if (matchId !== "a") return "ok";
    await slow;
    return "fail";
  });
  await page.goto("/");
  await page.click("#history-button");
  const rows = page.locator("#history-list button");
  await rows.nth(0).click();
  await page.click("#replay-close");
  await rows.nth(1).click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));

  const failed = page.waitForResponse((response) => response.url().endsWith("/api/replay"));
  release();
  await failed;
  await painted(page);
  await expect(page.locator("#history-status")).toBeEmpty();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
});

test("追い越された問い合わせの失敗は、描けた局面の見出しを隠さない", async ({ page }) => {
  const [slow, release] = gate();
  await mockHistory(page, async (_matchId, ply) => {
    if (ply !== 1) return "ok";
    await slow;
    return "fail";
  });
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-next");
  await page.click("#replay-next");
  await expect(page.locator("#replay-status")).toContainText(atPly(2));

  const failed = page.waitForResponse((response) => response.url().endsWith("/api/replay"));
  release();
  await failed;
  await painted(page);
  await expect(page.locator("#replay-status")).toContainText(atPly(2));
});

test("最初の局面が描けるまでは、辿るボタンを押せない", async ({ page }) => {
  const [slow, release] = gate();
  await mockHistory(page, async () => {
    await slow;
    return "ok";
  });
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-next")).toBeDisabled();
  release();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await expect(page.locator("#replay-next")).toBeEnabled();
});

test("辿れなかったときも、描けている局面の手数を出したままにする", async ({ page }) => {
  await mockHistory(page, async (_matchId, ply) => (ply === 1 ? "fail" : "ok"));
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-next");
  await expect(page.locator("#replay-status")).toContainText("辿れませんでした");
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
});

test("サーバがプレイヤーを忘れて作り直したら、前のプレイヤーの一覧とリプレイを出さない", async ({
  page,
}) => {
  await mockHistory(page, async () => "ok");
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));

  // 作り直したプレイヤーはまだ対戦を指していない。
  await page.route("**/api/matches", (route) => route.fulfill({ json: { matches: [] } }));
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, code: "account-not-found", errors: ["断った"] } }),
  );
  await page.route("**/api/account/me", (route) =>
    route.fulfill({ status: 404, json: { error: "いない", code: "account-not-found" } }),
  );
  // 1 度目で断られ、2 度目の前にプレイヤーを作り直す。
  for (let round = 0; round < 2; round += 1) {
    const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
    await page.click("#join-button");
    await joined;
    await expect(page.locator("#join-button")).toBeEnabled();
  }
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await expect(page.locator("#replay")).toHaveCount(0);
});

test("一覧を取り直せなかったあとに開けなかったら、開けなかった理由を出す", async ({ page }) => {
  await mockHistory(page, async () => "fail");
  await page.goto("/");
  await page.click("#history-button");
  await expect(page.locator("#history-list button")).toHaveCount(2);
  await page.route("**/api/matches", (route) =>
    route.fulfill({ status: 503, json: { error: "落とした" } }),
  );
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("一覧を出せませんでした");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#history-status")).toContainText("開けませんでした");
});

test("端でさらに押しても、同じ局面を取りに行かない", async ({ page }) => {
  const asked: number[] = [];
  await mockHistory(page, async (_matchId, ply) => {
    asked.push(ply);
    return "ok";
  });
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-prev");
  await page.click("#replay-first");
  await page.click("#replay-next");
  await expect(page.locator("#replay-status")).toContainText(atPly(1));
  expect(asked).toEqual([0, 1]);
});

test("一覧を取りに行けなかった理由は、取り直しているあいだは出さない", async ({ page }) => {
  const [slow, release] = gate();
  let calls = 0;
  await page.route("**/api/matches", async (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ json: { matches: [] } });
    if (calls === 2) return route.fulfill({ status: 503, json: { error: "落とした" } });
    await slow;
    return route.fulfill({ json: { matches: [] } });
  });
  await page.goto("/");
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  // 一覧を持っている取り直しの失敗は、次の取り直しのあいだも失敗のまま残る。
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("一覧を出せませんでした");
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toBeEmpty();
  release();
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
});

test("サーバがプレイヤーを忘れていたら、次に一覧を出すときにプレイヤーを作り直す", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#history-button")).toBeEnabled();
  await page.route("**/api/matches", (route) => route.fulfill(accountMissing));
  await page.route("**/api/account/me", (route) => route.fulfill(accountMissing));
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("アカウントが見つからない");

  await page.unroute("**/api/matches");
  const created = page.waitForRequest((request) => request.url().endsWith("/api/account"));
  await page.click("#history-button");
  await created;
  // 作り直したプレイヤーの一覧を、押し直さずに出す。
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
});

test("プレイヤーを作っているあいだに押しても、作り終えたら一覧を出す", async ({ page }) => {
  const [slow, release] = gate();
  // 初めて開いた画面はシークレットを持たないので、プレイヤーを作るところで止める。
  await page.route("**/api/account", async (route) => {
    await slow;
    await route.continue();
  });
  let listed = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/matches")) listed += 1;
  });
  await page.goto("/");
  await page.click("#history-button");
  release();
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await painted(page);
  expect(listed).toBe(1);
});

test("リプレイでサーバがプレイヤーを忘れていたと分かったら、次に一覧を出すときに作り直す", async ({
  page,
}) => {
  await mockHistory(page, async () => "ok");
  await page.goto("/");
  await page.click("#history-button");
  await expect(page.locator("#history-list button")).toHaveCount(2);
  await page.route("**/api/replay", (route) => route.fulfill(accountMissing));
  await page.route("**/api/account/me", (route) => route.fulfill(accountMissing));
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#history-status")).toContainText("開けませんでした");

  const created = page.waitForRequest((request) => request.url().endsWith("/api/account"));
  await page.click("#history-button");
  await created;
});

test("席に着いたまま開き直しても、一覧の欄はプレイヤーを読みに行かない", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/account")) asked.push(request.url());
  });
  await page.routeWebSocket(
    (url) => url.searchParams.has("seatToken"),
    () => {},
  );
  await page.addInitScript(() => {
    localStorage.setItem(
      "poke-seat",
      JSON.stringify({ seat: 0, seatToken: "つながったままの座席" }),
    );
  });
  await page.goto("/");
  await expect(page.locator("#table")).toBeVisible();
  await expect(page.locator("#history")).toBeAttached();
  await painted(page);
  expect(asked).toEqual([]);
});

test("返ってこない問い合わせは、同じ手数を押し直せば頼み直す", async ({ page }) => {
  const [never] = gate();
  let lastAsked = 0;
  await mockHistory(page, async (_matchId, ply) => {
    if (ply === 10 && lastAsked++ === 0) await never;
    return "ok";
  });
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-last");
  await page.click("#replay-last");
  await expect(page.locator("#replay-status")).toContainText(atPly(10));
});

test("再現できない地点は、手前へ戻っても出したままにする", async ({ page }) => {
  await mockHistory(page, async () => "ok", 4);
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-last");
  await expect(page.locator("#replay-status")).toContainText("5 手目から先は");
  await page.click("#replay-prev");
  await expect(page.locator("#replay-status")).toContainText(atPly(3));
  await expect(page.locator("#replay-status")).toContainText("5 手目から先は");
});

test("最初の局面が返ってこなくても、同じ対戦を押し直せば開き直す", async ({ page }) => {
  const [never] = gate();
  let opened = 0;
  await mockHistory(page, async () => {
    if (opened++ === 0) await never;
    return "ok";
  });
  await page.goto("/");
  await page.click("#history-button");
  const row = page.locator("#history-list button").first();
  await row.click();
  await expect(page.locator("#replay-next")).toBeDisabled();
  await row.click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
});

test("プレイヤーを用意できなかったら、その理由を一覧の欄に出す", async ({ page }) => {
  await page.route("**/api/account", (route) =>
    route.fulfill({ status: 503, json: { error: "作れなかった" } }),
  );
  const failed = page.waitForResponse((response) => response.url().endsWith("/api/account"));
  await page.goto("/");
  await failed;
  // ロビーが開いたときに用意できなかったことは、一覧の欄では言わない。
  await painted(page);
  await expect(page.locator("#history-status")).toBeEmpty();
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("作れなかった");
});

test("覚えているプレイヤーを読み直しているあいだに押しても、一覧は 1 度だけ頼む", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("poke-account-secret")))
    .not.toBeNull();

  const [slow, release] = gate();
  await page.route("**/api/account/me", async (route) => {
    await slow;
    await route.continue();
  });
  let listed = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/matches")) listed += 1;
  });
  await page.reload();
  await page.click("#history-button");
  release();
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await painted(page);
  expect(listed).toBe(1);
});

test("忘れられていたと言われても同じプレイヤーが読めたら、次に押したときに一覧を出す", async ({
  page,
}) => {
  let once = true;
  await page.route("**/api/matches", async (route) => {
    if (!once) return route.continue();
    once = false;
    return route.fulfill(accountMissing);
  });
  await page.goto("/");
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("アカウントが見つからない");
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await expect(page.locator("#history-status")).toBeEmpty();
});

test("プレイヤーを作り直している途中に続けて押しても、作るのは 1 人だけ", async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("poke-account-secret")))
    .not.toBeNull();
  await page.route("**/api/matches", (route) => route.fulfill(accountMissing));
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("アカウントが見つからない");

  await page.route("**/api/account/me", (route) => route.fulfill(accountMissing));
  const [slow, release] = gate();
  let created = 0;
  await page.route("**/api/account", async (route) => {
    created += 1;
    await slow;
    await route.continue();
  });
  await page.click("#history-button");
  await expect.poll(() => created).toBe(1);
  await page.click("#history-button");
  await painted(page);
  release();
  await expect(page.locator("#history-status")).toContainText("アカウントが見つからない");
  expect(created).toBe(1);
});

test("ロビーでプレイヤーが忘れられていたと分かったら、一覧は作り直したプレイヤーで頼む", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("poke-account-secret")))
    .not.toBeNull();
  const old = await page.evaluate(() => localStorage.getItem("poke-account-secret"));
  await page.route("**/api/join", (route) =>
    route.fulfill({ json: { ok: false, code: "account-not-found", errors: ["断った"] } }),
  );
  await page.route("**/api/account/me", (route) => route.fulfill(accountMissing));
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("断った");

  const sent: unknown[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/matches")) sent.push(request.postDataJSON());
  });
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  expect(sent).not.toContainEqual({ secret: old });
});

test("別のタブがシークレットを消していたら、次に一覧を出すときにプレイヤーを作り直す", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("poke-account-secret")))
    .not.toBeNull();
  await page.evaluate(() => localStorage.removeItem("poke-account-secret"));
  await page.click("#history-button");
  await expect(page.locator("#history-status")).toContainText("プレイヤーを用意できなかった");
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
});

test("追い越された局面の再現できない地点は、見出しに出さない", async ({ page }) => {
  const [slow, release] = gate();
  await mockHistory(
    page,
    async (_matchId, ply) => {
      if (ply === 10) await slow;
      return "ok";
    },
    4,
  );
  await page.goto("/");
  await page.click("#history-button");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-next");
  await expect(page.locator("#replay-status")).toContainText(atPly(1));
  const last = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/replay") &&
      (response.request().postDataJSON() as { ply: number }).ply === 10,
  );
  await page.click("#replay-last");
  await page.click("#replay-first");
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  release();
  await last;
  await painted(page);
  await expect(page.locator("#replay-status")).not.toContainText("手目から先は");
});

/**
 * AI どうしの対戦を、サーバと同じ組み立てで最初の数手ぶん観戦者へ流したときに届くもの。
 * AI は候補の先頭を指す。重みは使わないので、e2e のサーバに重みを置かずに済む。
 */
async function botWatchMessages(moves: number): Promise<string[]> {
  ensureCards();
  const first: Bot = {
    identity: { name: "first", label: "first", generation: 0, weightsSha256: "" },
    tracksKnowledge: false,
    choose: () => 0,
  };
  const registry = new MatchRegistry();
  const match = createMatch({
    matchId: "e2e-bot-watch",
    decks: legalDecks(),
    seats: [
      { playerId: "bot:first", displayName: "AI first（1）", rating: null },
      { playerId: "bot:first", displayName: "AI first（2）", rating: null },
    ],
    seatTokens: ["e2e-bot-watch-0", "e2e-bot-watch-1"],
    spectatorToken: "e2e-bot-watch",
    nowMs: 0,
    startedAt: new Date(0).toISOString(),
    bots: [first, first],
  });
  registry.add(match);
  const hub = new MatchHub({ registry, watchDelayMs: 0 });
  const sent: string[] = [];
  hub.attachSpectator({ send: (data) => void sent.push(data), close() {} }, "e2e-bot-watch");
  while (match.version < moves) await new Promise((resolve) => setTimeout(resolve, 1));
  // 決着を付けて AI を止める。記録は作らない（Worker の外ではエンジンの版を引けない）。
  concede(match, 0, 0);
  // 局面の一式と、そのあとの手の数だけの局面。そこから先は送らない。
  return sent.slice(0, moves + 1);
}

test("AI どうしの対戦は 1 手ずつ送り、止めて進めて戻せる。両者の手札も描く", async ({ page }) => {
  const messages = await botWatchMessages(5);
  await page.clock.install();
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    for (const message of messages) ws.send(message);
  });
  await page.goto("/?watch=e2e-bot-watch");

  const position = page.locator("#watch-position");
  await expect(position).toHaveAttribute("data-latest", "5");
  await expect(position).toHaveAttribute("data-shown", "0");
  for (const player of [0, 1]) {
    await expect(page.locator(`#watch-side-${player} .hand .card[data-def-id]`)).not.toHaveCount(0);
  }

  // 人が選ぶまでは 1 秒ごとに送る。
  await page.clock.runFor(1_000);
  await expect(position).toHaveAttribute("data-shown", "1");
  await expect(page.locator("#watch-move")).not.toBeEmpty();

  await page.click("#watch-play");
  await page.clock.runFor(3_000);
  await expect(position).toHaveAttribute("data-shown", "1");
  await page.click("#watch-forward");
  await expect(position).toHaveAttribute("data-shown", "2");
  await page.click("#watch-back");
  await page.click("#watch-back");
  await expect(position).toHaveAttribute("data-shown", "0");
  await expect(page.locator("#watch-back")).toBeDisabled();

  await page.selectOption("#watch-speed", "0");
  await page.click("#watch-play");
  await expect(position).toHaveAttribute("data-shown", "5");
});
