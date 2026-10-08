/** 画面（`web/`）のテストの続き。1 つのファイルが長くなりすぎないよう、`client.spec.ts` から分けている。 */

import { createHash } from "node:crypto";
import {
  expect,
  test,
  type Locator,
  type Page,
  type WebSocket,
  type WebSocketRoute,
} from "@playwright/test";
import type { Bot } from "../src/bots.js";
import { legalMoves, type Move, type Player, type PlayerView } from "../src/engine.js";
import { MatchHub } from "../src/hub.js";
import type { Seated } from "../src/lobby.js";
import { concede, createMatch, submitMove, toMove, viewFor } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";
import {
  basicEnergyDefId,
  ensureCards,
  finishSetup,
  legalDecks,
  newMatch,
} from "../tests/helpers.js";

/** ルームコードの欄は畳んであるので、開いてから入れる。 */
async function enterRoom(page: Page, room: string): Promise<void> {
  const details = page.locator("details.room");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  await page.fill("#room", room);
}

test("画面を開くとロビーが描け、アセットに無いパスでも画面の骨組みが返る", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto("/");
  await expect(page.locator(".site-header")).toBeVisible();
  await expect(page.locator("#join")).toBeVisible();

  // アセットに無いパスにも、画面の骨組みを返す（`wrangler.jsonc` の `not_found_handling`）。
  const response = await page.request.get("/no-such-page");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("<title>");

  expect(errors).toEqual([]);
});

test("無いページは、見つからないと出してトップへの道を残す", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.locator("#not-found")).toBeVisible();
  await page.locator("#not-found a").click();
  await expect(page.locator("#join")).toBeVisible();
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
  await enterRoom(page, `おしなおし-${Date.now()}`);
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

test("AI のデッキには、学習したデッキの名前か、選んだデッキのカードを送る", async ({ page }) => {
  // 重みを置かなくても欄を出せるよう、AI の一覧だけ差し替える。
  await page.route("**/api/bots", async (route) => {
    const answer = (await (await route.fetch()).json()) as { decks: unknown[] };
    await route.fulfill({
      json: { ...answer, bots: [{ name: "g0", size: 0, uploadedAt: "" }] },
    });
  });
  const sent: { botDeck: unknown }[] = [];
  await page.route("**/api/join-bot", async (route) => {
    sent.push(route.request().postDataJSON() as { botDeck: unknown });
    await route.fulfill({ status: 400, json: { ok: false, errors: ["断った"] } });
  });

  await page.goto("/");
  await expect(page.locator("#bot-button")).toBeEnabled();
  await page.click("#bot-button");
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.botDeck).toEqual(expect.any(String));

  await page.selectOption("#bot-deck", "sample");
  await expect(page.locator("#bot-button")).toBeEnabled();
  await page.click("#bot-button");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.botDeck).toMatchObject({ cards: expect.any(Array) });
});

test("相手を待つあいだに押し直して断られても、前のチケットを待ち続ける", async ({ page }) => {
  const claimed = () => page.waitForResponse((response) => response.url().includes("/api/claim?"));
  const status = page.locator("#join-status");

  await page.goto("/");
  await enterRoom(page, `まちつづける-${Date.now()}`);
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
  await enterRoom(page, room);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  const { ticket } = (await (await answered).json()) as { ticket: string };

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto("/");
    await enterRoom(opponent, room);
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
  const unplayable = await saveDeckAs(page, "くみかけ", [{ defId: "組みかけ", count: 1 }]);
  await page.reload();
  await enterRoom(page, room);
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("つながらなかった");

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto("/");
    await enterRoom(opponent, room);
    const seated = opponent.waitForResponse((response) => response.url().endsWith("/api/join"));
    await opponent.click("#join-button");
    const outcome = (await (await seated).json()) as { seat: Seated };
    // 相手は座席 1 に座るので、こちらの席は座席 0 である。
    const commit = outcome.seat.seedShareCommits[0];
    // 規則に通らないデッキを選んでも、続いている対戦へは戻れる。
    await page.locator("#deck-choice").selectOption(`saved:${unplayable}`);

    const opened = openedSeat(page.waitForEvent("websocket"));
    await page.click("#join-button");
    const { share } = await opened;
    expect(commitOf(share)).toBe(commit);
  } finally {
    await other.close();
  }
});

type Entry = { defId: string; count: number };

/** このページのプレイヤーとしてデッキを保存する。プレイヤーを用意し終えるのを待ってから送る。 */
async function saveDeckAs(page: Page, name: string, cards: Entry[]): Promise<string> {
  const secret = () => page.evaluate(() => localStorage.getItem("poke-account-secret"));
  await expect.poll(secret).not.toBeNull();
  const response = await page.request.post("/api/decks/save", {
    data: { secret: await secret(), name, cards },
  });
  const { deck } = (await response.json()) as { deck: { deckId: string } };
  return deck.deckId;
}

async function sampleEntries(page: Page): Promise<Entry[]> {
  const deck = (await (await page.request.get("/api/sample-deck")).json()) as { cards: string[] };
  const counts = new Map<string, number>();
  for (const defId of deck.cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  return [...counts].map(([defId, count]) => ({ defId, count }));
}

/** サンプルデッキの先頭のカードを、検索から 1 枚足す。 */
async function addFirstSampleCard(page: Page): Promise<string> {
  const [{ defId }] = (await sampleEntries(page)) as [Entry];
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { name: string; set?: string; number?: string }
  >;
  const card = cards[defId] as { name: string; set?: string; number?: string };
  await page.fill("#card-search", [card.name, card.set, card.number].filter(Boolean).join(" "));
  await page.locator(`#card-results .card-row[data-def-id="${defId}"] button.add`).click();
  return defId;
}

test("新しく組んだデッキを保存すると、そのデッキのページへ移り、一覧に並ぶ", async ({ page }) => {
  await page.goto("/decks/new");
  await page.fill("#deck-name", "  はじめての\u0000デッキ ");
  const defId = await addFirstSampleCard(page);
  await page.click("#save-deck-button");
  await expect(page).not.toHaveURL(/\/decks\/new$/);
  // サーバが整えた名前を出す。1 枚では規則を通らないことも出す。
  await expect(page.locator("#deck-name")).toHaveValue("はじめてのデッキ");
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
  await expect(page.locator("#save-deck-button")).toBeDisabled();

  await page.reload();
  await expect(page.locator(`#deck-cards .card-row[data-def-id="${defId}"]`)).toHaveCount(1);
  await page.locator(".site-nav a", { hasText: "デッキ" }).click();
  await expect(page.locator("#deck-list .deck-item")).toHaveCount(1);
  await expect(page.locator("#deck-list .deck-meta")).toHaveClass(/ng/);
});

test("保存していない変更があれば、ページを離れる前に捨ててよいかを尋ねる", async ({ page }) => {
  await page.goto("/decks/new");
  await addFirstSampleCard(page);
  const nav = page.locator(".site-nav a", { hasText: "デッキ" });

  page.once("dialog", (dialog) => void dialog.dismiss());
  await nav.click();
  await expect(page).toHaveURL(/\/decks\/new$/);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);

  page.once("dialog", (dialog) => void dialog.accept());
  await nav.click();
  await expect(page.locator("#decks")).toBeVisible();
});

test("保存できなかったら理由を出し、組んだデッキを残す", async ({ page }) => {
  await page.route("**/api/decks/save", (route) => route.abort());
  await page.goto("/decks/new");
  await addFirstSampleCard(page);
  await page.click("#save-deck-button");
  await expect(page.locator("#deck-status")).toContainText("保存できませんでした");
  await expect(page).toHaveURL(/\/decks\/new$/);
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
  await expect(page.locator("#save-deck-button")).toBeEnabled();
});

test("保存を待つあいだに打ち直した名前は、保存の答えで戻さない", async ({ page }) => {
  await page.goto("/");
  const deckId = await saveDeckAs(page, "まえの名前", await sampleEntries(page));
  const [held, release] = gate();
  await page.route("**/api/decks/save", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(`/decks/${deckId}`);
  await page.fill("#deck-name", "送った名前");
  await page.click("#save-deck-button");
  await page.fill("#deck-name", "あとで打った名前");
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/decks/save"));
  release();
  await saved;
  await expect(page.locator("#save-deck-button")).toBeEnabled();
  await expect(page.locator("#deck-name")).toHaveValue("あとで打った名前");
});

test("前の版がこのブラウザに残した組みかけは、一度だけ保存したデッキへ移す", async ({ page }) => {
  // ロビーが一覧を読み終えてから置く。読んでいる途中に置くと、ロビーとデッキのページの両方が移す。
  const listed = page.waitForResponse((response) => response.url().endsWith("/api/decks"));
  await page.goto("/");
  await listed;
  await page.evaluate(() => {
    localStorage.setItem("poke-deck", JSON.stringify([{ defId: "組みかけ", count: 2 }]));
  });
  await page.goto("/decks");
  await expect(page.locator("#deck-list .deck-item")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#deck-list .deck-item")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("poke-deck"))).toBeNull();
});

test("保存したデッキを選んで対戦をさがすとそのデッキを送り、選んだデッキを次に開いたときも選ぶ", async ({
  page,
}) => {
  await page.goto("/");
  const cards = await sampleEntries(page);
  const deckId = await saveDeckAs(page, "つかうデッキ", cards);
  const sent: unknown[] = [];
  await page.route("**/api/join", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: false, code: "queue-full", errors: ["断った"] } });
  });
  await page.reload();
  // 規則を通る保存したデッキがあれば、はじめはそれを選んでおく。
  await expect(page.locator("#deck-choice")).toHaveValue(`saved:${deckId}`);
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("断った");
  const [request] = sent as [{ deck: { cards: string[] } }];
  expect([...request.deck.cards].sort()).toEqual(
    cards.flatMap(({ defId, count }) => Array<string>(count).fill(defId)).sort(),
  );

  await page.locator("#deck-choice").selectOption("sample");
  await page.reload();
  await expect(page.locator("#deck-choice")).toHaveValue("sample");
});

test("規則を通らない保存したデッキを選ぶと、直すページへの道を出す", async ({ page }) => {
  await page.goto("/");
  const deckId = await saveDeckAs(page, "くみかけ", [{ defId: "組みかけ", count: 1 }]);
  await page.reload();
  // 規則を通らないデッキは、はじめからは選ばない。
  await expect(page.locator("#deck-choice")).toHaveValue(/^preset:/);
  await page.locator("#deck-choice").selectOption(`saved:${deckId}`);
  await page.locator("#deck-note a").click();
  await expect(page).toHaveURL(new RegExp(`/decks/${deckId}$`));
  await expect(page.locator("#deck-status")).toHaveClass(/ng/);
});

test("一覧から、対戦に使うデッキを選んでトップへ戻れ、デッキを消せる", async ({ page }) => {
  await page.goto("/");
  const deckId = await saveDeckAs(page, "つかうデッキ", await sampleEntries(page));
  await page.goto("/decks");
  const item = page.locator(`#deck-list .deck-item[data-deck-id="${deckId}"]`);
  await item.locator(".play-deck").click();
  await expect(page.locator("#deck-choice")).toHaveValue(`saved:${deckId}`);

  await page.goto("/decks");
  page.once("dialog", (dialog) => void dialog.accept());
  await item.locator(".delete-deck").click();
  await expect(item).toHaveCount(0);
});

test("前に選んだデッキが一覧に無ければ、ほかのデッキで入る", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("poke-deck-choice", "saved:消したデッキ"));
  const sent: unknown[] = [];
  await page.route("**/api/join", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: false, code: "queue-full", errors: ["断った"] } });
  });
  await page.goto("/");
  // AI と同じ表のデッキにする。サンプルデッキは AI が学んだことの無い相手になる。
  await expect(page.locator("#deck-choice")).toHaveValue(/^preset:/);
  await page.click("#join-button");
  await expect(page.locator("#join-status")).toContainText("断った");
  expect(sent).toEqual([expect.objectContaining({ deckPreset: expect.any(String) })]);
});

test("保存したあとに一覧を読み直せなくても、組んでいる画面を閉じない", async ({ page }) => {
  await page.goto("/");
  const deckId = await saveDeckAs(page, "くみなおす", await sampleEntries(page));
  await page.goto(`/decks/${deckId}`);
  await page.locator("#deck-cards .card-row button.remove").first().click();
  let failed = 0;
  await page.route("**/api/decks", async (route) => {
    failed += 1;
    await route.fulfill({ status: 503, json: { error: "落とした" } });
  });
  // 保存すると一覧を読み直す。読み直しは 3 度まで頼み直してから失敗になる。
  await page.click("#save-deck-button");
  await expect.poll(() => failed, { timeout: 20_000 }).toBe(4);
  await painted(page);
  await expect(page.locator("#deck-builder")).toBeVisible();
  // 保存したデッキと比べるので、保存していない変更は無い。
  await expect(page.locator("#save-deck-button")).toBeDisabled();
});

test("プレイヤーを用意できなければ、デッキの一覧にその理由を出す", async ({ page }) => {
  await page.route("**/api/account", (route) =>
    route.fulfill({ status: 503, json: { error: "作れなかった" } }),
  );
  await page.goto("/decks");
  await expect(page.locator("#decks-status")).toContainText("作れなかった");
});

test("相手を待っているあいだにページを移るときは、確かめてからチケットを降ろす", async ({
  page,
}) => {
  await page.goto("/");
  await enterRoom(page, `やめる-${Date.now()}`);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  const { ticket } = (await (await answered).json()) as { ticket: string };
  await page.waitForResponse((response) => response.url().includes("/api/claim?"));
  const nav = page.locator('.site-nav a[href="/decks"]');

  page.once("dialog", (dialog) => void dialog.dismiss());
  await nav.click();
  await expect(page.locator("#join")).toBeVisible();

  const left = page.waitForRequest((request) => request.url().endsWith("/api/leave"));
  page.once("dialog", (dialog) => void dialog.accept());
  await nav.click();
  expect((await left).postDataJSON()).toEqual({ ticket });
  await expect(page.locator("#decks")).toBeVisible();
  const claimed = await page.request.get(`/api/claim?ticket=${encodeURIComponent(ticket)}`);
  expect(((await claimed.json()) as { kind: string }).kind).toBe("dropped");
});

test("相手を待っているあいだに同じページへ移っても、確かめずに待ち続ける", async ({ page }) => {
  let asked = 0;
  page.on("dialog", (dialog) => {
    asked += 1;
    void dialog.dismiss();
  });
  await page.goto("/");
  await enterRoom(page, `おなじ-${Date.now()}`);
  await page.click("#join-button");
  await page.waitForResponse((response) => response.url().includes("/api/claim?"));
  await page.click('.site-nav a[href="/"]');
  await page.waitForResponse((response) => response.url().includes("/api/claim?"));
  expect(asked).toBe(0);
});

test("チケットを降ろせなかったら、ページを移らずに待ち続ける", async ({ page }) => {
  await page.route("**/api/leave", (route) => route.abort());
  await page.goto("/");
  await enterRoom(page, `おろせない-${Date.now()}`);
  await page.click("#join-button");
  await page.waitForResponse((response) => response.url().includes("/api/claim?"));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.click('.site-nav a[href="/decks"]');
  await expect(page.locator("#join-status")).toContainText("やめられませんでした");
  await expect(page.locator("#join")).toBeVisible();
  await page.waitForResponse((response) => response.url().includes("/api/claim?"));
});

test("保存したデッキの一覧が届く前に押しても、前に選んだ保存したデッキで入る", async ({ page }) => {
  await page.goto("/");
  const cards = await sampleEntries(page);
  const deckId = await saveDeckAs(page, "えらんだ", cards);
  await page.evaluate((id) => localStorage.setItem("poke-deck-choice", `saved:${id}`), deckId);
  const [held, release] = gate();
  await page.route("**/api/decks", async (route) => {
    await held;
    await route.continue();
  });
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/join"));
  await page.reload();
  await enterRoom(page, `とどくまえ-${Date.now()}`);
  await page.click("#join-button");
  release();
  const { deck } = (await sent).postDataJSON() as { deck: { cards: string[] } };
  expect([...deck.cards].sort()).toEqual(
    cards.flatMap(({ defId, count }) => Array<string>(count).fill(defId)).sort(),
  );
});

test("表のデッキを選んでいれば、保存したデッキの一覧を待たずに入る", async ({ page }) => {
  await page.goto("/");
  const choice = page.locator("#deck-choice");
  await expect(choice).toHaveValue(/^preset:/);
  const preset = await choice.inputValue();
  await choice.selectOption("sample");
  await choice.selectOption(preset);
  await page.route("**/api/decks", () => {});
  await page.reload();
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/join"));
  await enterRoom(page, `またない-${Date.now()}`);
  await page.click("#join-button");
  expect((await sent).postDataJSON()).toMatchObject({ deckPreset: preset.slice("preset:".length) });
  await expect(page.locator("#join-status")).toContainText("相手を待っています");
});

test("保存したデッキの一覧を読めなければ、画面に出ている表のデッキで入る", async ({ page }) => {
  await page.route("**/api/decks", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/");
  const choice = page.locator("#deck-choice");
  await expect(choice).toHaveValue(/^preset:/);
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/join"));
  await enterRoom(page, `よめない-${Date.now()}`);
  await page.click("#join-button");
  const preset = (await choice.inputValue()).slice("preset:".length);
  expect((await sent).postDataJSON()).toMatchObject({ deckPreset: preset });
  await expect(page.locator("#join-status")).toContainText("相手を待っています");
});

test("相手さがしの答えを待つあいだにページを移っても、届いたチケットを降ろす", async ({ page }) => {
  const [held, release] = gate();
  await page.route("**/api/join", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await enterRoom(page, `まつまえに-${Date.now()}`);
  // 頼む前にページを移ると、画面はリクエストを送らない。降ろすチケットが無いので、送ったのを見てから移る。
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/join"));
  await page.click("#join-button");
  await sent;
  await page.click('.site-nav a[href="/decks"]');
  await expect(page.locator("#decks")).toBeVisible();
  const left = page.waitForRequest((request) => request.url().endsWith("/api/leave"));
  release();
  await left;
});

test("チケットを降ろす前に相手が見つかっていたら、移ろうとしたページではなく卓へ移る", async ({
  page,
  browser,
}) => {
  // 待つあいだの取り直しでは席を渡さない。降ろすときにサーバが返す席だけで着くようにする。
  await page.route("**/api/claim?**", (route) => route.fulfill({ json: { kind: "waiting" } }));
  const room = `みつかっていた-${Date.now()}`;
  await page.goto("/");
  await enterRoom(page, room);
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/join"));
  await page.click("#join-button");
  await answered;
  await expect(page.locator("#join-status")).toContainText("相手を待っています");

  const other = await browser.newContext();
  try {
    const opponent = await other.newPage();
    await opponent.goto("/");
    await enterRoom(opponent, room);
    const seated = opponent.waitForResponse((response) => response.url().endsWith("/api/join"));
    await opponent.click("#join-button");
    const { seat } = (await (await seated).json()) as { seat: Seated };

    const opened = openedSeat(page.waitForEvent("websocket"));
    page.once("dialog", (dialog) => void dialog.accept());
    await page.click('.site-nav a[href="/decks"]');
    await expect(page).toHaveURL(/\/match$/);
    // 相手は座席 1 に座るので、こちらは座席 0 である。待っていたチケットのシェアで着く。
    expect(commitOf((await opened).share)).toBe(seat.seedShareCommits[0]);
  } finally {
    await other.close();
  }
});

test("対戦の記録のページは、開くたびに一覧を取り直す", async ({ page }) => {
  let listed = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/matches")) listed += 1;
  });
  await page.goto("/history");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await page.click('.site-nav a[href="/"]');
  await page.click('.site-nav a[href="/history"]');
  await expect.poll(() => listed).toBe(2);
});

test("画像を読めなかったカードは、候補の行に小さな面を残さない", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", (route) => route.fulfill({ status: 502, body: "" }));
  await page.goto("/decks/new");
  await page.fill("#card-search", "エネルギー");
  await expect(page.locator("#card-results .card-row").first()).toBeVisible();
  await expect(page.locator("#card-results .card.thumb")).toHaveCount(0);
});

test("読んでいる最中の画像は、あとから出た同じカードのために頼み直さない", async ({ page }) => {
  const asked: string[] = [];
  const [held, release] = gate();
  await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
  await page.route("**/api/card-image/*", async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    await held;
    await route.fulfill({ status: 502, body: "" });
  });
  await page.goto("/decks/new");
  await page.fill("#card-search", "エネルギー");
  const last = page.locator("#card-results .card-row").last();
  await expect(last.locator("img")).toHaveCount(1);
  const defId = (await last.getAttribute("data-def-id")) as string;
  const row = page.locator(`#card-results .card-row[data-def-id="${defId}"]`);
  const cards = (await (await page.request.get("/api/cards")).json()) as Record<
    string,
    { cardID?: string }
  >;
  const path = `/api/card-image/${cards[defId]?.cardID}`;
  await expect.poll(() => asked).toContain(path);

  // 読んでいる最中に、同じカードを隠したデッキの行に出す。`loading="lazy"` の画像は隠れているあいだ
  // 頼まないので、失敗が分かったあとで見えたときに頼まないかを確かめる。
  const hiding = await page.addStyleTag({ content: "#deck-cards { display: none; }" });
  await row.locator("button.add").click();
  await expect(page.locator("#deck-cards .card-row")).toHaveCount(1);
  release();
  await expect(row.locator(".card")).toHaveCount(0);
  await hiding.evaluate((style) => (style as HTMLStyleElement).remove());
  await expect(page.locator("#deck-cards .card-row")).toBeVisible();
  await expect(page.locator("#deck-cards .card-row .card")).toHaveCount(0);
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
  await page.goto("/history");
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
  await page.goto("/history");
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
  await expect(page.locator("#motion-toggle")).not.toBeChecked();
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  await page.clock.runFor(20);
  expect(await inZone()).toBe(true);
});

test("OS で動きを減らす設定にしていても、画面で演出を出すとカードを動かす", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [before, after] = placingActive();
  const { card, inZone } = await openPlacing(page, before, after);
  await setMotion(page, true);
  await page.click("#replay-next");
  await expect(card).toBeVisible();
  await page.clock.runFor(20);
  expect(await inZone()).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("poke-motion"))).toBe("on");
});

test("開いているあいだに OS で動きを減らす設定にしたら、演出を止める", async ({ page }) => {
  const [before, after] = placingActive();
  await openPlacing(page, before, after);
  const toggle = page.locator("#motion-toggle");
  await expect(toggle).toBeChecked();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle).not.toBeChecked();
});

test("画面で演出を切っていたら、カードを動かさずに場に置く", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("poke-motion", "off"));
  const [before, after] = placingActive();
  const { card, inZone } = await openPlacing(page, before, after);
  await expect(page.locator("#motion-toggle")).not.toBeChecked();
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

/**
 * 覚えている座席の代わりに、サーバとして `view` の局面を送る。`sent` は画面が送ってきた手、
 * `shown` は画面が見せ終えたと知らせてきた局面の版。返す `send` は、イベントを載せて続けて局面を送る。
 */
async function mockSeat(page: Page, view: PlayerView, offered: Move[] | null = null) {
  await page.addInitScript((seat) => {
    localStorage.setItem("poke-seat", JSON.stringify({ seat, seatToken: "差し替えた座席" }));
  }, view.viewer);
  const choices = { setup: null, deckPlacement: null, answerDestinations: null };
  const clock = { bankMs: [600_000, 600_000], moveRemainingMs: null, toMove: null };
  let version = 1;
  let socket: WebSocketRoute | null = null;
  const sent: Move[] = [];
  /** 手と一緒に送ってきた、見せた手の位置。 */
  const offers: (number[] | undefined)[] = [];
  const shown: number[] = [];
  await page.routeWebSocket(
    (url) => url.searchParams.has("seatToken"),
    (route) => {
      socket = route;
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.t === "shown") shown.push(message.stateVersion);
        if (message.t !== "move") return;
        sent.push(message.move);
        offers.push(message.offered);
      });
      // 座席からは何も送らなくても、繋がったらサーバが局面一式を送る。
      route.send(
        JSON.stringify({
          t: "sync",
          matchId: "差し替えた対戦",
          seat: view.viewer,
          stateVersion: version,
          view,
          legalMoves: offered,
          ...choices,
          revealedDeck: null,
          attacks: null,
          mulligans: [],
          firstPlayer: view.viewer,
          // 相手がトスに勝って後攻を選んだ、AI との対戦の始まりと同じ形にする。
          toss: view.viewer === 0 ? 1 : 0,
          clock,
          seedCommit: "0".repeat(64),
          spectatorToken: "差し替えた観戦",
        }),
      );
    },
  );
  const header = { seq: 0, turn: view.turn, window: { kind: "turn", player: view.turnPlayer } };
  const send = (events: Record<string, unknown>[], next: PlayerView = view) => {
    version += 1;
    socket!.send(
      JSON.stringify({
        t: "delta",
        stateVersion: version,
        events: events.map((event) => ({ ...header, actor: null, source: null, ...event })),
        view: next,
        legalMoves: null,
        ...choices,
        revealedDeck: null,
        attacks: null,
        clock,
      }),
    );
  };
  return { sent, offers, shown, send };
}

/** 覚えている座席で画面を開き、サーバの代わりに `view` の局面を送って、時計を止める。 */
async function seatWithEvents(page: Page, view: PlayerView) {
  await page.clock.install();
  const { send } = await mockSeat(page, view);
  await page.goto("/");
  await expect(page.locator("#self .mat")).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
  // 先攻を知らせる結果を消しておく。
  await page.clock.runFor(10_000);
  await expect(page.locator("#results .result")).toHaveCount(0);
  return send;
}

test("トスを見ないまま始まった対戦では、始まったときにトスの結果をコインで見せる", async ({
  page,
}) => {
  const [, placed] = placingActive();
  await mockSeat(page, placed[0]!);
  await page.goto("/");
  // 相手が勝ったトスなので、コインは負けの向きで止まる。
  await expect(page.locator("#results .result").first().locator(".coin")).toHaveAttribute(
    "data-face",
    "tails",
  );
});

function activeOf(view: PlayerView) {
  const active = view.self.active;
  if (active === null || "concealed" in active) throw new Error("バトル場にポケモンがいない");
  return active;
}

const damageTo = (target: string) => ({
  kind: "damage-dealt",
  target,
  amount: 30,
  beforeDamage: 0,
  afterDamage: 30,
  cause: { kind: "damage-counter" },
});

test("1 つの局面の結果は順に出し、次の局面が届いたら残りを待たせずに出す", async ({ page }) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  const results = page.locator("#results .result");
  const hits = page.locator(".hit");

  send([
    { kind: "coin-flipped", player: 0, results: [true] },
    damageTo(activeOf(view).inPlayId),
    { kind: "turn-started", player: 1 },
  ]);
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("コイン");
  // コインの次は、コインが回り終えてから出す。
  await page.clock.runFor(900);
  await expect(results).toHaveCount(1);
  await expect(hits).toHaveCount(0);
  await page.clock.runFor(200);
  await expect(results).toHaveCount(2);
  await expect(results.last()).toContainText("30 ダメージ");
  await expect(hits).toHaveCount(1);

  // 番の交代はまだ待っている。次の局面が届いたら、それを待たせずに出してから、次の局面の結果を出す。
  send([{ kind: "turn-started", player: 0 }]);
  await expect(results).toHaveCount(4);
  await expect(results.nth(2)).toContainText("相手の番");
  await expect(results.nth(3)).toContainText("あなたの番");
});

test("局面の結果を出し終えてから、見せ終えたことをサーバへ知らせる", async ({ page }) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  await page.clock.install();
  const { send, shown } = await mockSeat(page, view);
  await page.goto("/");
  await expect(page.locator("#self .mat")).toBeVisible();
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1_000);
  await page.clock.runFor(10_000);
  await expect.poll(() => shown).toEqual([1]);

  // コインが回り終え、続く 2 つの結果を出し終えるまでは知らせない。
  send([
    { kind: "coin-flipped", player: 0, results: [true] },
    damageTo(activeOf(view).inPlayId),
    { kind: "turn-started", player: 1 },
  ]);
  await page.clock.runFor(1_600);
  expect(shown).toEqual([1]);
  await page.clock.runFor(300);
  await expect.poll(() => shown).toEqual([1, 2]);
});

test("ダメージの数字は、ポケモンが動き終えてからその位置に浮かべる", async ({ page }) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  const benched = structuredClone(view);
  benched.self.bench = [structuredClone(activeOf(view))];
  benched.self.active = null;

  send([damageTo(activeOf(view).inPlayId)], benched);
  await expect(page.locator("#results .result")).toHaveCount(1);
  const pokemon = page.locator('#self [data-zone="bench"] .pokemon');
  await page.clock.runFor(20);
  await expect(pokemon).toHaveAttribute("data-moving");
  await page.clock.runFor(200);
  await expect(page.locator(".hit")).toHaveCount(0);
  await page.clock.runFor(700);
  const hit = page.locator(".hit");
  await expect(hit).toBeVisible();
  const [box, spot] = [await pokemon.boundingBox(), await hit.boundingBox()];
  if (box === null || spot === null) throw new Error("ポケモンか数字が描けていない");
  const middle = spot.x + spot.width / 2;
  expect(middle).toBeGreaterThan(box.x);
  expect(middle).toBeLessThan(box.x + box.width);
});

test("数字を浮かべるときにポケモンがまだ動いていたら、止まるまで出さない", async ({ page }) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  const pokemon = page.locator('#self [data-zone="active"] .pokemon');
  // 描くのが遅れて、動かす長さを過ぎてもまだ動いているところ。
  await pokemon.evaluate((node) => node.setAttribute("data-moving", "shifting"));

  send([damageTo(activeOf(view).inPlayId)]);
  await page.clock.runFor(1_000);
  const hit = page.locator(".hit");
  await expect(hit).toBeAttached();
  await expect(hit).toBeHidden();
  await pokemon.evaluate((node) => node.removeAttribute("data-moving"));
  await expect(hit).toBeVisible();
});

test("数字を待たせているあいだにポケモンが別の場所へ移ったら、移った先に浮かべる", async ({
  page,
}) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  await page
    .locator('#self [data-zone="active"] .pokemon')
    .evaluate((node) => node.setAttribute("data-moving", "shifting"));
  send([damageTo(activeOf(view).inPlayId)]);
  await page.clock.runFor(1_000);
  await expect(page.locator(".hit")).toBeHidden();

  // 次の局面でベンチへ下がると、ポケモンは別の要素に描き直される。
  const benched = structuredClone(view);
  benched.self.bench = [structuredClone(activeOf(view))];
  benched.self.active = null;
  send([], benched);
  await page.clock.runFor(1_000);
  const [box, spot] = [
    await page.locator('#self [data-zone="bench"] .pokemon').boundingBox(),
    await page.locator(".hit").boundingBox(),
  ];
  if (box === null || spot === null) throw new Error("ポケモンか数字が描けていない");
  const middle = spot.x + spot.width / 2;
  expect(middle).toBeGreaterThan(box.x);
  expect(middle).toBeLessThan(box.x + box.width);
});

test("OS で動きを減らす設定にしていたら、結果と数字を待たせずに出す", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  send([
    { kind: "coin-flipped", player: 0, results: [true] },
    damageTo(activeOf(view).inPlayId),
    { kind: "turn-started", player: 1 },
  ]);
  await expect(page.locator("#results .result")).toHaveCount(3);
  await expect(page.locator(".hit")).toBeVisible();
  expect(
    await page
      .locator("#results .result")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
});

test("画面で演出を切ると、結果を待たせずに出し、切ったことを覚えておく", async ({ page }) => {
  const [, placed] = placingActive();
  const view = placed[0]!;
  const send = await seatWithEvents(page, view);
  const results = page.locator("#results .result");
  send([
    { kind: "coin-flipped", player: 0, results: [true] },
    damageTo(activeOf(view).inPlayId),
    { kind: "turn-started", player: 1 },
  ]);
  await expect(results).toHaveCount(1);

  // 待たせている結果と数字も、切ったらすぐ出す。
  await setMotion(page, false);
  await expect(results).toHaveCount(3);
  await expect(page.locator(".hit")).toBeVisible();
  expect(await results.first().evaluate((node) => getComputedStyle(node).animationName)).toBe(
    "none",
  );

  send([damageTo(activeOf(view).inPlayId), { kind: "turn-started", player: 0 }]);
  await expect(results).toHaveCount(5);
  await expect(page.locator(".hit")).toHaveCount(2);

  await page.reload();
  await expect(page.locator("#motion-toggle")).not.toBeChecked();
});

/** 手札に 1 枚足し、`counts` の枚数を 1 枚ずつ減らした局面。 */
function drawnFrom(view: PlayerView, ...counts: ("prizeCount" | "deckCount")[]) {
  const next = structuredClone(view);
  next.self.hand.push({ ...next.self.hand[0]!, instanceId: "手札に入ったカード" });
  for (const count of counts) next.self[count] -= 1;
  return next;
}

/** 手札のカードが 1 枚増えるまで待ち、最後のカード（増えたカード）を返す。 */
async function newestHandCard(page: Page, next: PlayerView) {
  const hand = page.locator('#self [data-zone="hand"] .card');
  await expect(hand).toHaveCount(next.self.hand.length);
  return hand.last();
}

/**
 * 盤面のアニメーションを止めたまま進める。`page.clock` は Web Animations の時計を止めないので、
 * 負荷が高いと、来た場所を測る前に動き終えてしまう。
 */
async function holdAnimations(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
}

/** 入ったカードの動きを始めに戻して止め、そのときのカードの中心と `from` の要素の中心の隔たり。 */
async function arrivalGap(card: Locator, from: string) {
  await expect(card).toHaveAttribute("data-moving", "arriving");
  return card.evaluate((node, selector) => {
    for (const animation of node.getAnimations()) {
      animation.pause();
      animation.currentTime = 0;
    }
    const source = document.querySelector(selector);
    if (source === null) throw new Error("来た場所が描けていない");
    const [start, at] = [source.getBoundingClientRect(), node.getBoundingClientRect()];
    return Math.hypot(
      start.left + start.width / 2 - (at.left + at.width / 2),
      start.top + start.height / 2 - (at.top + at.height / 2),
    );
  }, from);
}

const animationsOf = (card: Locator) => card.evaluate((node) => node.getAnimations().length);

test("サイドを取ると、取ったカードをサイドから手札へ動かす", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  const next = drawnFrom(view, "prizeCount");
  send([], next);
  const card = await newestHandCard(page, next);
  expect(await arrivalGap(card, '#self .mat [data-zone="prizes"]')).toBeLessThan(2);
});

test("山札から引くと、引いたカードを山札から手札へ動かし、動き終えたら印を外す", async ({
  page,
}) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  const next = drawnFrom(view, "deckCount");
  send([], next);
  const card = await newestHandCard(page, next);
  expect(await arrivalGap(card, '#self .mat [data-zone="deck"]')).toBeLessThan(2);
  await card.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
  await expect(card).not.toHaveAttribute("data-moving");
});

test("動いている途中で次の局面が届いても、手札へ入るカードを止めない", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  const next = drawnFrom(view, "deckCount");
  send([], next);
  const card = await newestHandCard(page, next);
  await expect(card).toHaveAttribute("data-moving", "arriving");
  // 動き終えても消えるので、途中で止めておく。消えるのは、次の局面で取り消したときだけになる。
  await card.evaluate((node) => node.getAnimations().forEach((animation) => animation.pause()));
  const later = structuredClone(next);
  later.opponent.handCount += 1;
  send([], later);
  await expect(page.locator('#opponent [data-zone="hand"]')).toHaveAttribute(
    "data-count",
    String(later.opponent.handCount),
  );
  expect(await animationsOf(card)).toBe(1);
});

test("サイドと山札が一緒に減ると、どちらから来たか分からないので動かさない", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  const next = drawnFrom(view, "prizeCount", "deckCount");
  send([], next);
  expect(await animationsOf(await newestHandCard(page, next))).toBe(0);
});

test("相手が山札から引くと、伏せた手札に増えたカードを相手の山札から動かす", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  // 1 枚を手札から出し、2 枚引いた局面。
  const next = structuredClone(view);
  next.opponent.handCount += 1;
  next.opponent.deckCount -= 2;
  send([], next);
  const hand = page.locator('#opponent [data-zone="hand"] .card');
  await expect(hand).toHaveCount(next.opponent.handCount);
  const deck = '#opponent .mat [data-zone="deck"]';
  expect(await arrivalGap(hand.last(), deck)).toBeLessThan(2);
  expect(await arrivalGap(hand.nth(-2), deck)).toBeLessThan(2);
  expect(await animationsOf(hand.nth(-3))).toBe(0);
});

/** 相手が自分の番に、手札のエネルギーを相手のバトル場のポケモンにつけた局面とイベント。 */
function opponentAttaches(view: PlayerView) {
  const next = structuredClone(view);
  const active = next.opponent.active;
  if (active === null || "concealed" in active) throw new Error("相手のバトル場にポケモンがいない");
  const card = { instanceId: "相手がつけたエネルギー", defId: basicEnergyDefId() };
  active.attached.push(card);
  next.opponent.handCount -= 1;
  const player = 1 - view.viewer;
  const event = {
    kind: "energy-attached",
    window: { kind: "turn", player },
    actor: player,
    player,
    card,
    target: active.inPlayId,
    fromHand: true,
    from: { kind: "hand", player },
  };
  return { next, event, card };
}

test("相手が手札から出したカードは、相手の手札から動かし、盤面の横に大きく見せる", async ({
  page,
}) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  const { next, event, card } = opponentAttaches(view);
  send([event], next);
  const attached = page.locator(`#opponent [data-zone="active"] .attached .card`).last();
  await expect(attached).toHaveAttribute("data-def-id", card.defId);
  expect(await arrivalGap(attached, '#opponent [data-zone="hand"]')).toBeLessThan(2);
  await expect(page.locator(".showcase .card")).toHaveAttribute("data-def-id", card.defId);
  await expect(page.locator("#results .result")).toHaveCount(1);
  await page.clock.runFor(1_600);
  await expect(page.locator(".showcase")).toHaveCount(0);
});

test("自分でしたことは、記録に残すが結果には出さず、大きくも見せない", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  const { next, event } = opponentAttaches(view);
  const logged = await page.locator("#events li").count();
  const self = { kind: "turn", player: view.viewer };
  send([{ ...event, window: self, actor: view.viewer, player: view.viewer }], next);
  await expect(page.locator("#events li")).toHaveCount(logged + 1);
  await page.clock.runFor(100);
  await expect(page.locator("#results .result")).toHaveCount(0);
  await expect(page.locator(".showcase")).toHaveCount(0);
});

test("前の局面で盤面に見えていたカードが手札に入っても、山札からは動かさない", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  const next = drawnFrom(view, "deckCount");
  // 手札に入るカードを、前の局面ではトラッシュに置いておく。
  const before = structuredClone(view);
  before.self.discard.push(next.self.hand.at(-1)!);
  send([], before);
  await expect(page.locator('#self [data-zone="discard"] .card[data-def-id]')).toHaveCount(1);
  send([], next);
  expect(await animationsOf(await newestHandCard(page, next))).toBe(0);
});

test("前の局面でスタジアムに見えていたカードが手札に入っても、山札からは動かさない", async ({
  page,
}) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  const next = drawnFrom(view, "deckCount");
  const before = structuredClone(view);
  before.stadium = next.self.hand.at(-1)!;
  send([], before);
  await expect(page.locator('[data-zone="stadium"] .card[data-def-id]')).toHaveCount(1);
  send([], next);
  expect(await animationsOf(await newestHandCard(page, next))).toBe(0);
});

test("手札のカードが山札へ入ると、写しを山札まで動かして消す", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await holdAnimations(page);
  const next = structuredClone(view);
  if (!("hand" in next.self)) throw new Error("手札が見えない");
  const [card] = next.self.hand.splice(0, 1);
  next.self.deckCount += 1;
  send([], next);
  const ghost = page.locator("body > .card[data-moving]");
  await expect(ghost).toHaveAttribute("data-def-id", card!.defId);
  // 動き終える直前で止め、山札のカードに重なっているかを見る。
  const gap = await ghost.evaluate((node) => {
    for (const animation of node.getAnimations()) {
      animation.pause();
      animation.currentTime = Number(animation.effect!.getComputedTiming().endTime) - 1;
    }
    const deck = document.querySelector('#self .mat [data-zone="deck"] .card')!;
    const [to, at] = [deck.getBoundingClientRect(), node.getBoundingClientRect()];
    return Math.hypot(
      to.left + to.width / 2 - (at.left + at.width / 2),
      to.top + to.height / 2 - (at.top + at.height / 2),
    );
  });
  expect(gap).toBeLessThan(2);
  await ghost.evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
  await expect(ghost).toHaveCount(0);
});

test("山札を切ると、切った側の山札を広げて重ね直す", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  send([{ kind: "deck-shuffled", player: 1 - view.viewer }]);
  const shuffling = page.locator('#opponent [data-zone="deck"] .shuffling');
  await expect(shuffling).toBeVisible();
  await expect(page.locator('#self [data-zone="deck"] .shuffling')).toHaveCount(0);
  // 切ったことは結果の通知には出さない。
  await expect(page.locator("#results .result")).toHaveCount(0);
  await shuffling.evaluate((node) =>
    node.getAnimations({ subtree: true }).forEach((animation) => animation.finish()),
  );
  await expect(shuffling).toHaveCount(0);
  await setMotion(page, false);
  send([{ kind: "deck-shuffled", player: view.viewer }]);
  await expect(page.locator('#self [data-zone="deck"]')).toBeVisible();
  await page.clock.runFor(100);
  await expect(page.locator(".shuffling")).toHaveCount(0);
});

test("画面で演出を切っていたら、引いたカードを動かさずに手札に置く", async ({ page }) => {
  const { view } = firstTurn();
  const send = await seatWithEvents(page, view);
  await setMotion(page, false);
  const next = drawnFrom(view, "deckCount");
  send([], next);
  const card = await newestHandCard(page, next);
  expect(await card.getAttribute("data-moving")).toBeNull();
  expect(await animationsOf(card)).toBe(0);
  // あとで演出を戻しても、前に入ったカードを動かし直さない。
  await setMotion(page, true);
  expect(await animationsOf(card)).toBe(0);
  // OS の設定と同じほうへ戻したので、選んだことは忘れて OS の設定に従う。
  expect(await page.evaluate(() => localStorage.getItem("poke-motion"))).toBeNull();
});

/** 準備を終え、最初の番の手を持つ座席から見た盤面と、その手。 */
function firstTurn(): { view: PlayerView; moves: Move[] } {
  ensureCards();
  const match = newMatch("drag");
  finishSetup(match);
  return { view: viewFor(match, toMove(match) as Player), moves: legalMoves(match.state) };
}

/** エネルギーをつける手と、そのエネルギーが手札の何枚目か。 */
function attaching({ view, moves }: { view: PlayerView; moves: Move[] }) {
  const move = moves.find((each) => each.type === "AttachEnergy");
  if (move?.type !== "AttachEnergy") throw new Error("エネルギーをつける手が無い");
  const hand = "hand" in view.self ? view.self.hand : [];
  const index = hand.findIndex((card) => card.instanceId === move.cardInstanceId);
  return { move, index, defId: hand[index]!.defId };
}

/** マウスで `from` をつかんで `to` の上まで動かす。離すかどうかは呼ぶ側が決める。 */
async function dragOver(page: Page, from: Locator, to: Locator) {
  const [start, end] = [await from.boundingBox(), await to.boundingBox()];
  if (start === null || end === null) throw new Error("つかむカードか落とす先が描けていない");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
}

test("手札のエネルギーをポケモンへ落とすと、つける手を指す", async ({ page }) => {
  const turn = firstTurn();
  const { move, index, defId } = attaching(turn);
  const { sent } = await mockSeat(page, turn.view, turn.moves);
  await page.goto("/");
  const card = page.locator('#self [data-zone="hand"] .card').nth(index);
  await expect(card).toHaveAttribute("data-grippable");
  const target = page.locator(`#self .pokemon[data-in-play-id="${move.target}"]`);

  await dragOver(page, card, target);
  // つかんでいるあいだは、落とせる先を囲み、上に来ている先は囲みを太くする。
  await expect(target).toHaveAttribute("data-drop", "over");
  await expect(page.locator('#self [data-zone="bench"]')).not.toHaveAttribute("data-drop");
  await page.mouse.up();

  await expect.poll(() => sent.length).toBe(1);
  const played = sent[0]!;
  expect(played).toMatchObject({ type: "AttachEnergy", target: move.target });
  // 同じカードが何枚あっても、指すのはどれか 1 枚をつける手である。
  const hand = "hand" in turn.view.self ? turn.view.self.hand : [];
  const attached = "cardInstanceId" in played ? played.cardInstanceId : null;
  expect(hand.find((each) => each.instanceId === attached)?.defId).toBe(defId);
  await expect(target).not.toHaveAttribute("data-drop");
});

test("落とした先でできる手が 2 つ以上あれば、ボタンをそれだけに絞って選ばせる", async ({
  page,
}) => {
  const turn = firstTurn();
  const { move, index } = attaching(turn);
  const tool: Move = { ...move, type: "AttachTool" };
  const player = move.player;
  const moves: Move[] = [move, tool, { type: "EndTurn", player }];
  const { sent, offers } = await mockSeat(page, turn.view, moves);
  await page.goto("/");
  const card = page.locator('#self [data-zone="hand"] .card').nth(index);
  const target = page.locator(`#self .pokemon[data-in-play-id="${move.target}"]`);
  // 絞ったあいだは番を終えるボタンも隠し、記録に残す「見せた手」と揃える。
  const buttons = page.locator("#moves button, #end-turn");
  await expect(buttons).toHaveCount(3);

  await dragOver(page, card, target);
  await page.mouse.up();
  await expect(page.locator("#drop-prompt")).toBeVisible();
  await expect(buttons).toHaveCount(2);
  expect(sent).toEqual([]);
  await page.click("#drop-widen");
  await expect(buttons).toHaveCount(3);
  // ほかの手を出すと頼んだので、畳んだ一覧も開く。
  await expect(page.locator("#moves button").first()).toBeVisible();
  await expect(page.locator("#drop-prompt")).toHaveCount(0);

  await dragOver(page, card, target);
  await page.mouse.up();
  // 絞る前に押すと、先に並ぶ番を終えるボタンを数えてしまう。
  await expect(buttons).toHaveCount(2);
  await buttons.nth(1).click();
  await expect.poll(() => sent).toEqual([tool]);
  // 記録には、絞って見せた 2 つの手だけを見せたと残す。
  expect(offers).toEqual([[0, 1]]);
});

test("ベンチのポケモンの上で離しても、ベンチに出す手を指す", async ({ page }) => {
  const turn = firstTurn();
  const { index } = attaching(turn);
  const view = structuredClone(turn.view);
  const { copy } = anotherPokemon([view], 0);
  view.self.bench = [copy];
  const hand = "hand" in view.self ? view.self.hand : [];
  // 盤面の判断はしないので、手札のどのカードでも、サーバが出した手のとおりに落とせる。
  const bench: Move = {
    type: "PlayBasic",
    player: view.viewer,
    cardInstanceId: hand[index]!.instanceId,
    to: { kind: "bench", player: view.viewer, index: 1 },
  };
  const { sent } = await mockSeat(page, view, [bench]);
  await page.goto("/");
  const card = page.locator('#self [data-zone="hand"] .card').nth(index);
  const benched = page.locator(`#self .pokemon[data-in-play-id="${copy.inPlayId}"]`);

  await dragOver(page, card, benched);
  await expect(page.locator('#self [data-zone="bench"]')).toHaveAttribute("data-drop", "over");
  await page.mouse.up();
  await expect.poll(() => sent).toEqual([bench]);
});

test("ポケモンの横で離すと、カードの面がポケモンに重なっていても何も指さない", async ({ page }) => {
  const turn = firstTurn();
  const { move, index } = attaching(turn);
  const { sent } = await mockSeat(page, turn.view, turn.moves);
  await page.goto("/");
  const card = page.locator('#self [data-zone="hand"] .card').nth(index);
  const target = page.locator(`#self .pokemon[data-in-play-id="${move.target}"]`);
  const [start, end] = [await card.boundingBox(), await target.boundingBox()];
  if (start === null || end === null) throw new Error("カードかポケモンが描けていない");

  // つかんだ位置はカードの真ん中なので、ポケモンの左の端から少し外で離すと、カードの右半分が重なる。
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x - 8, end.y + end.height / 2, { steps: 20 });
  await expect(target).toHaveAttribute("data-drop", "ready");
  await page.mouse.up();
  await expect(target).not.toHaveAttribute("data-drop");
  expect(sent).toEqual([]);
});

test("落とせない先で離すと、何も指さない。押しただけなら、カードを大きく出す", async ({ page }) => {
  const turn = firstTurn();
  const { index } = attaching(turn);
  const { sent } = await mockSeat(page, turn.view, turn.moves);
  await page.goto("/");
  const card = page.locator('#self [data-zone="hand"] .card').nth(index);
  await expect(card).toHaveAttribute("data-grippable");

  await dragOver(page, card, page.locator('#self [data-zone="discard"]'));
  await page.mouse.up();
  await expect(page.locator("#drop-prompt")).toHaveCount(0);
  await expect(page.locator("#card-zoom")).toBeHidden();

  // 押したまましばらく待っても、動かさなければつかまない。
  const box = await card.boundingBox();
  if (box === null) throw new Error("カードが描けていない");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await expect(page.locator("#self [data-drop]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator("#card-zoom")).toBeVisible();
  expect(sent).toEqual([]);
});

test.describe("タッチ端末の座席", () => {
  test.use({ hasTouch: true });

  test("長押ししてから指をずらしても、カードはつかまない", async ({ page }) => {
    const turn = firstTurn();
    const { move, index } = attaching(turn);
    const { sent } = await mockSeat(page, turn.view, turn.moves);
    await page.goto("/");
    const card = page.locator('#self [data-zone="hand"] .card').nth(index);
    await expect(card).toHaveAttribute("data-grippable");
    const [from, to] = [
      await card.boundingBox(),
      await page.locator(`#self .pokemon[data-in-play-id="${move.target}"]`).boundingBox(),
    ];
    if (from === null || to === null) throw new Error("カードかポケモンが描けていない");

    // Playwright の `tap` は置いてすぐ離すので、CDP で指を置く。
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y }],
      });
    await touch("touchStart", from.x + from.width / 2, from.y + from.height / 2);
    await page.waitForTimeout(500);
    for (let step = 1; step <= 10; step += 1) {
      const x = from.x + from.width / 2 + ((to.x - from.x) * step) / 10;
      const y = from.y + from.height / 2 + ((to.y - from.y) * step) / 10;
      await touch("touchMove", x, y);
    }
    await expect(page.locator("#self [data-drop]")).toHaveCount(0);
    await touch("touchEnd", 0, 0);
    await page.waitForTimeout(200);
    expect(sent).toEqual([]);
  });

  test("カードを押してから光った先を押すと、その手を指す。同じカードをもう 1 度押すと大きく出す", async ({
    page,
  }) => {
    const turn = firstTurn();
    const { move, index } = attaching(turn);
    const { sent } = await mockSeat(page, turn.view, turn.moves);
    await page.goto("/");
    const card = page.locator('#self [data-zone="hand"] .card').nth(index);
    const target = page.locator(`#self .pokemon[data-in-play-id="${move.target}"]`);
    await expect(card).toHaveAttribute("data-grippable");

    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    await expect(target).toHaveAttribute("data-drop", "ready");
    await expect(page.locator('#self [data-zone="bench"]')).not.toHaveAttribute("data-drop");
    await expect(page.locator("#card-zoom")).toBeHidden();
    await card.tap();
    await expect(card).not.toHaveAttribute("data-picked");
    await expect(target).not.toHaveAttribute("data-drop");
    await expect(page.locator("#card-zoom")).toBeVisible();
    await page.locator("#card-zoom-close").tap();

    await card.tap();
    await target.tap();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ type: "AttachEnergy", target: move.target });
    await expect(page.locator("#card-zoom")).toBeHidden();
  });

  test("カードを押してから落とせない先を押すと、放すだけで何も指さない", async ({ page }) => {
    const turn = firstTurn();
    const { index } = attaching(turn);
    const { sent } = await mockSeat(page, turn.view, turn.moves);
    await page.goto("/");
    const card = page.locator('#self [data-zone="hand"] .card').nth(index);

    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    // 相手のポケモンは押せば大きく出すが、選んでいるあいだに押したときは放すだけにする。
    await page.locator("#opponent .pokemon").first().tap();
    await expect(card).not.toHaveAttribute("data-picked");
    await expect(page.locator("#self [data-drop]")).toHaveCount(0);
    await expect(page.locator("#card-zoom")).toBeHidden();
    await page.waitForTimeout(200);
    expect(sent).toEqual([]);

    // 盤面の外を押したときと Esc でも放す。
    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    await page.getByText("指せる手", { exact: true }).tap();
    await expect(card).not.toHaveAttribute("data-picked");
    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    await page.keyboard.press("Escape");
    await expect(card).not.toHaveAttribute("data-picked");

    // ボタンで手を指したら、選んでいたカードも放す。番の中の手は畳んであるので、選ぶ前に開く。
    await page.locator("#all-moves > summary").tap();
    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    await page.locator("#moves button").last().tap();
    await expect.poll(() => sent.length).toBe(1);
    await expect(card).not.toHaveAttribute("data-picked");
  });

  test("場のポケモンを押して大きく出すと、そのポケモンでできる手も並べ、押すと指す", async ({
    page,
  }) => {
    const turn = firstTurn();
    const attack: Move = { type: "Attack", player: turn.view.viewer, attackIndex: 0 };
    const { sent } = await mockSeat(page, turn.view, [...turn.moves, attack]);
    await page.goto("/");
    const zoom = page.locator("#card-zoom");
    const moves = page.locator("#card-zoom-moves button");

    // 相手のポケモンでできる手は無いので、大きく出すだけにする。
    await page.locator("#opponent .pokemon").first().tap();
    await expect(zoom).toBeVisible();
    await expect(moves).toHaveCount(0);
    await page.locator("#card-zoom-close").tap();

    await page.locator('#self [data-zone="active"] .pokemon').tap();
    await expect(zoom).toBeVisible();
    // 開いたキーを続けて押しても指さないよう、「閉じる」にいる。
    await expect(page.locator("#card-zoom-close")).toBeFocused();
    // ワザは最後に足したので、ここでも最後に並ぶ。
    await moves.last().tap();
    await expect.poll(() => sent).toEqual([attack]);
    await expect(zoom).toBeHidden();
  });

  test("カードを選んでいるあいだに盤面の番を終えるボタンを押すと、1 度でカードを放して番を終える", async ({
    page,
  }) => {
    const turn = firstTurn();
    const { index } = attaching(turn);
    const { sent } = await mockSeat(page, turn.view, turn.moves);
    await page.goto("/");
    const card = page.locator('#self [data-zone="hand"] .card').nth(index);

    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    await page.locator("#end-turn").tap();
    await expect.poll(() => sent).toEqual([{ type: "EndTurn", player: turn.view.viewer }]);
    await expect(card).not.toHaveAttribute("data-picked");
  });

  test("カードを選んでいるあいだに指せる手が無くなったら、カードを放す", async ({ page }) => {
    const turn = firstTurn();
    const { index } = attaching(turn);
    const { send } = await mockSeat(page, turn.view, turn.moves);
    await page.goto("/");
    const card = page.locator('#self [data-zone="hand"] .card').nth(index);

    await card.tap();
    await expect(card).toHaveAttribute("data-picked");
    send([]);
    await expect(page.locator("#moves button")).toHaveCount(0);
    await expect(card).not.toHaveAttribute("data-picked");
  });

  test("ベンチに出すカードを押してからベンチのポケモンを押しても、ベンチに出す手を指す", async ({
    page,
  }) => {
    const turn = firstTurn();
    const { index } = attaching(turn);
    const view = structuredClone(turn.view);
    const { copy } = anotherPokemon([view], 0);
    view.self.bench = [copy];
    const hand = "hand" in view.self ? view.self.hand : [];
    // 盤面の判断はしないので、手札のどのカードでも、サーバが出した手のとおりに落とせる。
    const bench: Move = {
      type: "PlayBasic",
      player: view.viewer,
      cardInstanceId: hand[index]!.instanceId,
      to: { kind: "bench", player: view.viewer, index: 1 },
    };
    const { sent } = await mockSeat(page, view, [bench]);
    await page.goto("/");

    await page.locator('#self [data-zone="hand"] .card').nth(index).tap();
    await page.locator(`#self .pokemon[data-in-play-id="${copy.inPlayId}"]`).tap();
    await expect.poll(() => sent).toEqual([bench]);
  });
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
  // プレビューが画面の上下の端で止まらない高さにして、カードとの位置の関係だけを見る。
  await page.setViewportSize({ width: 1280, height: 1600 });
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
  // プレビューが画面の上下の端で止まらない高さにして、カードとの位置の関係だけを見る。
  await page.setViewportSize({ width: 1280, height: 1600 });
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
  await page.goto("/decks/new");
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

test("閉じてすぐに同じカードを押しても、拡大を開き直す", async ({ page }) => {
  const hand = await replayHand(page);
  const zoom = page.locator("#card-zoom");
  await hand.first().click();
  await expect(zoom).toBeVisible();
  // dialog の close イベントは閉じたあとで届く。届く前に押し、届くまで待つ。
  await hand.first().evaluate(async (card) => {
    const dialog = document.querySelector("#card-zoom") as HTMLDialogElement;
    const closed = new Promise((resolve) =>
      dialog.addEventListener("close", resolve, { once: true }),
    );
    dialog.close();
    (card as HTMLElement).click();
    await closed;
  });
  await expect(zoom).toBeVisible();
  await expect(page.locator("#card-zoom-cards .card")).toHaveCount(1);
});

test.describe("タッチ端末", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  /** デッキを組む画面で、候補の行の小さな面を出す。 */
  async function searchedThumb(page: Page) {
    await page.route("**/api/config", (route) => route.fulfill({ json: { cardImages: true } }));
    // 返さない。読み込んでいるあいだも、候補の行には小さな面が出る。
    await page.route("**/api/card-image/*", () => {});
    await page.goto("/decks/new");
    await page.fill("#card-search", "エネルギー");
    const thumb = page.locator("#card-results .card-row .card").first();
    await expect(thumb).toBeVisible();
    return thumb;
  }

  test("長押しを指をずらしてやめたら、次にキーボードで押したボタンを止めない", async ({ page }) => {
    const thumb = await searchedThumb(page);
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

  test("指を離した直後に届くマウスの pointerover では、プレビューを出さない", async ({ page }) => {
    const thumb = await searchedThumb(page);
    // iOS と同じく、指を離したらその場所へマウスの pointerover を送る。送り終えたら印を付ける。
    await page.evaluate(() => {
      document.addEventListener("pointerup", (event) => {
        if (event.pointerType !== "touch" || !(event.target instanceof Element)) return;
        const { target } = event;
        setTimeout(() => {
          target.dispatchEvent(
            new PointerEvent("pointerover", { pointerType: "mouse", bubbles: true }),
          );
          document.body.dataset.emulated = "";
        });
      });
    });

    await thumb.tap();
    await expect(page.locator("body")).toHaveAttribute("data-emulated");
    await expect(page.locator("#card-preview")).toBeHidden();
  });

  test("マウスで出たプレビューも、指で押せば閉じる", async ({ page }) => {
    const thumb = await searchedThumb(page);
    await thumb.hover();
    await expect(page.locator("#card-preview")).toBeVisible();

    await page.locator("#card-search").tap();
    await expect(page.locator("#card-preview")).toBeHidden();
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
  await page.goto("/history");
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
  await page.goto("/history");
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
  await page.goto("/history");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-next")).toBeDisabled();
  release();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await expect(page.locator("#replay-next")).toBeEnabled();
});

test("辿れなかったときも、描けている局面の手数を出したままにする", async ({ page }) => {
  await mockHistory(page, async (_matchId, ply) => (ply === 1 ? "fail" : "ok"));
  await page.goto("/history");
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
  await page.goto("/history");
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
  await page.click('.site-nav a[href="/"]');
  for (let round = 0; round < 2; round += 1) {
    const joined = page.waitForResponse((response) => response.url().endsWith("/api/join"));
    await page.click("#join-button");
    await joined;
    await expect(page.locator("#join-button")).toBeEnabled();
  }
  await page.click('.site-nav a[href="/history"]');
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
});

test("一覧を取り直せなかったあとに開けなかったら、開けなかった理由を出す", async ({ page }) => {
  await mockHistory(page, async () => "fail");
  await page.goto("/history");
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
  await page.goto("/history");
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
  await page.goto("/history");
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
  await page.goto("/history");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
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

test("プレイヤーを作っているあいだに押しても、作るのは 1 人だけで、作り終えたら一覧を出す", async ({
  page,
}) => {
  const [slow, release] = gate();
  let created = 0;
  // 初めて開いた画面はシークレットを持たないので、プレイヤーを作るところで止める。
  await page.route("**/api/account", async (route) => {
    created += 1;
    await slow;
    await route.continue();
  });
  let listed = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/matches")) listed += 1;
  });
  await page.goto("/history");
  await expect.poll(() => created).toBe(1);
  await page.click("#history-button");
  release();
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await painted(page);
  expect(created).toBe(1);
  expect(listed).toBe(1);
});

test("リプレイでサーバがプレイヤーを忘れていたと分かったら、次に一覧を出すときに作り直す", async ({
  page,
}) => {
  await mockHistory(page, async () => "ok");
  await page.goto("/history");
  await expect(page.locator("#history-list button")).toHaveCount(2);
  await page.route("**/api/replay", (route) => route.fulfill(accountMissing));
  await page.route("**/api/account/me", (route) => route.fulfill(accountMissing));
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#history-status")).toContainText("開けませんでした");

  const created = page.waitForRequest((request) => request.url().endsWith("/api/account"));
  await page.click("#history-button");
  await created;
});

test("席に着いたまま開き直したら卓へ移り、プレイヤーを読みに行かない", async ({ page }) => {
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
  await page.goto("/history");
  await page.locator("#history-list button").first().click();
  await expect(page.locator("#replay-status")).toContainText(atPly(0));
  await page.click("#replay-last");
  await page.click("#replay-last");
  await expect(page.locator("#replay-status")).toContainText(atPly(10));
});

test("再現できない地点は、手前へ戻っても出したままにする", async ({ page }) => {
  await mockHistory(page, async () => "ok", 4);
  await page.goto("/history");
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
  await page.goto("/history");
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
  await page.goto("/history");
  await expect(page.locator("#history-status")).toContainText("作れなかった");
  // 読み直すと、プレイヤーを用意し直す。
  await page.unroute("**/api/account");
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await expect(page.locator("#history-status")).toBeEmpty();
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
  await page.goto("/history");
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
  await page.goto("/history");
  await expect(page.locator("#history-status")).toContainText("アカウントが見つからない");
  await page.click("#history-button");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  await expect(page.locator("#history-status")).toBeEmpty();
});

test("プレイヤーを作り直している途中に続けて押しても、作るのは 1 人だけ", async ({ page }) => {
  await page.goto("/history");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
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
  await page.click('.site-nav a[href="/history"]');
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
  expect(sent).not.toContainEqual({ secret: old });
});

test("別のタブがシークレットを消していたら、次に一覧を出すときにプレイヤーを作り直す", async ({
  page,
}) => {
  await page.goto("/history");
  await expect(page.locator("#history-list")).toContainText("まだ読み返せる対戦がありません");
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
  await page.goto("/history");
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
  await page.goto("/watch/e2e-bot-watch");

  const position = page.locator("#watch-position");
  await expect(position).toHaveAttribute("data-latest", "5");
  await expect(position).toHaveAttribute("data-shown", "0");
  for (const player of [0, 1]) {
    await expect(page.locator(`#watch-side-${player} .hand .card[data-def-id]`)).not.toHaveCount(0);
  }

  // 人が選ぶまでは、コイントスのコインが回り終えてから 1 秒置いて送る。
  await page.clock.runFor(1_500);
  await expect(position).toHaveAttribute("data-shown", "0");
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

/** 設定のダイアログを開いて、演出を出すかを切り替える。 */
async function setMotion(page: Page, on: boolean): Promise<void> {
  await page.locator('[id$="settings-button"]:visible').first().click();
  await page.locator("#motion-toggle").setChecked(on);
  await page.click("#settings-close");
}
