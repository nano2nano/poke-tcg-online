/**
 * 保存したデッキ（`docs/spec/battle-server.md` 5.5 節）。
 *
 * シークレットで引いたプレイヤーのデッキしか読み書きできないこと、保存できる数に上限があることを、
 * 本物の Worker に要求を送って確かめる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/database.js";
import { DECK_LIMIT, DECK_NOT_FOUND, TOO_MANY_DECKS } from "../src/decks.js";
import { sampleDeck } from "../src/sample-deck.js";
import { ensureCards } from "./helpers.js";
import { startWorker, type TestWorker } from "./worker.js";

let worker: TestWorker;

beforeAll(async () => {
  ensureCards();
  worker = await startWorker({ ACCOUNT_BURST: "0" });
});

afterAll(async () => {
  await worker.close();
});

type JsonBody = Record<string, any>;

async function postJson(path: string, body: unknown): Promise<{ status: number; body: JsonBody }> {
  const response = await fetch(`http://${worker.host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonBody };
}

async function newPlayer(): Promise<string> {
  const { body } = await postJson("/api/account", {});
  return body.secret as string;
}

function sampleEntries(): { defId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const defId of sampleDeck().cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  return [...counts].map(([defId, count]) => ({ defId, count }));
}

describe("保存したデッキ", () => {
  it("保存して一覧で読め、置き換えると新しいものが先に並ぶ", async () => {
    const secret = await newPlayer();
    const cards = sampleEntries();
    const first = await postJson("/api/decks/save", { secret, name: "はじめ", cards });
    expect(first.status).toBe(200);
    expect(first.body.deck.errors).toEqual([]);
    const second = await postJson("/api/decks/save", {
      secret,
      name: "くみかけ",
      cards: cards.slice(0, 1),
    });
    // 組みかけでも保存できる。規則に通らないことは読むたびに添える。
    expect(second.status).toBe(200);
    expect(second.body.deck.errors).not.toEqual([]);

    const renamed = await postJson("/api/decks/save", {
      secret,
      deckId: first.body.deck.deckId,
      name: "  なおした\u0000 ",
      cards,
    });
    expect(renamed.body.deck.name).toBe("なおした");

    const { body } = await postJson("/api/decks", { secret });
    expect(body.decks.map((deck: JsonBody) => deck.name)).toEqual(["なおした", "くみかけ"]);
    expect(body.decks[0].cards).toEqual(cards);
  });

  it("ほかの人のデッキは読めず、置き換えも消すこともできない", async () => {
    const [owner, other] = await Promise.all([newPlayer(), newPlayer()]);
    const { body } = await postJson("/api/decks/save", {
      secret: owner,
      name: "じぶんの",
      cards: sampleEntries(),
    });
    const { deckId } = body.deck as { deckId: string };

    expect((await postJson("/api/decks", { secret: other })).body.decks).toEqual([]);
    const replaced = await postJson("/api/decks/save", {
      secret: other,
      deckId,
      name: "のっとり",
      cards: [],
    });
    expect(replaced.status).toBe(404);
    expect(replaced.body.code).toBe(DECK_NOT_FOUND);
    expect((await postJson("/api/decks/delete", { secret: other, deckId })).status).toBe(404);

    const kept = await postJson("/api/decks", { secret: owner });
    expect(kept.body.decks.map((deck: JsonBody) => deck.name)).toEqual(["じぶんの"]);
    expect((await postJson("/api/decks/delete", { secret: owner, deckId })).status).toBe(200);
    expect((await postJson("/api/decks", { secret: owner })).body.decks).toEqual([]);
  });

  // 数えてから足す 2 段にすると、並んで届いた保存がどれも上限の手前で数えて、上限を越える。
  it("並んで届いた保存でも、上限を越えて保存しない", async () => {
    const secret = await newPlayer();
    const saves = await Promise.all(
      Array.from({ length: DECK_LIMIT + 5 }, (_, index) =>
        postJson("/api/decks/save", { secret, name: `${index}`, cards: [] }),
      ),
    );
    const refused = saves.filter(({ status }) => status !== 200);
    expect(refused).toHaveLength(5);
    expect(refused.every(({ body }) => body.code === TOO_MANY_DECKS)).toBe(true);
    expect((await postJson("/api/decks", { secret })).body.decks).toHaveLength(DECK_LIMIT);
  });

  it("シークレットの合わない要求は、アカウントが無いと答える", async () => {
    const { status, body } = await postJson("/api/decks", { secret: "しらない" });
    expect(status).toBe(404);
    expect(body.code).toBe("account-not-found");
  });

  it("合わせて 60 枚を越えるデッキと、同じカードを 2 行に分けたデッキは、形が違うとして断る", async () => {
    const secret = await newPlayer();
    const save = (cards: { defId: string; count: number }[]) =>
      postJson("/api/decks/save", { secret, name: "だめ", cards });
    const [first, second] = sampleEntries();
    expect(
      (
        await save([
          { defId: first!.defId, count: 31 },
          { defId: second!.defId, count: 30 },
        ])
      ).status,
    ).toBe(400);
    expect((await save([first!, first!])).status).toBe(400);
    expect((await postJson("/api/decks", { secret })).body.decks).toEqual([]);
  });
});

/** 表は Durable Object が起きたときに作る。本番の D1 には、デッキの表が無い前の版の表がある。 */
describe("表の形", () => {
  it("前の版の表のところへ起きると、残りの段だけを当てて、ある行を残す", async () => {
    const secret = await newPlayer();
    const before = await worker.db
      .prepare("SELECT COUNT(*) AS n FROM players")
      .first<{ n: number }>();
    await worker.db.exec("DROP TABLE decks");
    await worker.db.prepare("DELETE FROM schema_version WHERE version > 1").run();

    await ensureSchema(worker.db);
    const after = await worker.db
      .prepare("SELECT COUNT(*) AS n FROM players")
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    const saved = await postJson("/api/decks/save", { secret, name: "あとから", cards: [] });
    expect(saved.status).toBe(200);
  });
});
