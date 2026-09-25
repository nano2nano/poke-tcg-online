/**
 * AI と、本物のサーバを通して 1 局指す（`docs/spec/battle-server.md` 7.3 節）。
 *
 * 重みの読み込みはエンジンの Node 向けのコード（`Buffer`、`node:crypto`）を通る。
 * Worker の上で読めることは、Worker を起こさないと確かめられない。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { INITIAL_RATING } from "../src/accounts.js";
import { BOT_PREFIX } from "../src/bots.js";
import { encodePpoWeights, newPpoWeightsFile } from "../src/engine.js";
import type { MatchRecord } from "../src/log.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { ensureCards } from "./helpers.js";
import { startWorker, type TestWorker } from "./worker.js";

let worker: TestWorker;

beforeAll(async () => {
  ensureCards();
  worker = await startWorker({ ACCOUNT_BURST: "0", BOT_DELAY_MS: "0" });
  await worker.archive.put(`${BOT_PREFIX}g0`, encodePpoWeights(newPpoWeightsFile("test-bot")));
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

describe("AI と対戦する", () => {
  it("置いた重みが一覧に出る", async () => {
    const response = await fetch(`http://${worker.host}/api/bots`);
    const body = (await response.json()) as JsonBody;
    expect(body.bots.map((bot: JsonBody) => bot.name)).toEqual(["g0"]);
    expect(body.decks.length).toBeGreaterThan(0);
  });

  it("デッキの名前は、看板のカードの名前をカードの表から引ける", async () => {
    const { decks } = (await (await fetch(`http://${worker.host}/api/bots`)).json()) as JsonBody;
    const cards = (await (await fetch(`http://${worker.host}/api/cards`)).json()) as JsonBody;
    for (const deck of decks as JsonBody[]) {
      expect(cards[deck.ace]?.name, deck.label).toEqual(expect.any(String));
    }
    // 名前が重なると、選択肢のどれがどのデッキか画面で見分けられない。
    const names = (decks as JsonBody[]).map((deck) => cards[deck.ace].name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("置いていない AI は断る", async () => {
    const { secret } = (await postJson("/api/account", { displayName: "ひと" })).body;
    const outcome = await postJson("/api/join-bot", {
      secret,
      bot: "not-there",
      botDeck: "fudin",
      deckPreset: "doraparuto",
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body.ok).toBe(false);
  });

  it("人が合法手を返すだけで決着まで進み、記録には AI の手と重みが残る", async () => {
    const { secret, account } = (await postJson("/api/account", { displayName: "ひと" })).body;
    const joined = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "fudin",
      deckPreset: "doraparuto",
    });
    expect(joined.body.ok).toBe(true);

    const socket = new WebSocket(`ws://${worker.host}/ws?seatToken=${joined.body.seat.seatToken}`);
    const ended = await new Promise<ServerMessage>((resolve) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as ServerMessage;
        if (message.t === "ended") resolve(message);
        if (message.t !== "sync" && message.t !== "delta") return;
        const legal = message.legalMoves;
        if (legal === null || legal.length === 0) return;
        const move: ClientMessage = {
          t: "move",
          stateVersion: message.stateVersion,
          move: legal[0]!,
        };
        socket.send(JSON.stringify(move));
      });
    });
    socket.close();
    expect(ended.t).toBe("ended");

    // 決着を残し終えてから読む。`/api/account/me` はレーティングが動き終わるのを待って答える。
    const me = (await postJson("/api/account/me", { secret })).body;
    expect(me).toMatchObject({ rating: INITIAL_RATING, games: 0 });
    const { objects } = await worker.archive.list({ prefix: "matches/" });
    const records: MatchRecord[] = [];
    for (const { key } of objects) {
      records.push(JSON.parse(await (await worker.archive.get(key))!.text()) as MatchRecord);
    }
    const record = records.find((each) => each.seats[0].playerId === account.playerId);
    expect(record?.seats[1].bot).toMatchObject({ name: "g0", label: "test-bot", generation: 0 });
    expect(record?.moves.some((move) => move.source === "bot")).toBe(true);
    const listed = (await postJson("/api/matches", { secret })).body.matches as JsonBody[];
    expect(listed.map((summary) => summary.matchId)).toEqual([record?.matchId]);

    // 決着が付けば、次の AI との対戦を始められる。
    const next = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "fudin",
      deckPreset: "doraparuto",
    });
    expect(next.body.ok).toBe(true);
    // 続いているあいだは断り、その席を返す。
    const refused = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "fudin",
      deckPreset: "doraparuto",
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "bot-match-live", seat: next.body.seat });
  });

  /**
   * シェアを出さずに入ると、対戦は席を渡した時点で始まっている。準備で AI が先に選ぶ対戦では、
   * 人が繋ぐ前に AI が指していなければならない。AI が先になる対戦を引くまで開き直す。
   */
  it("AI が先に選ぶ対戦では、人が繋ぐ前に AI が指している", async () => {
    let versionOnAttach: number | null = null;
    for (let attempt = 0; attempt < 16 && versionOnAttach === null; attempt++) {
      const { secret } = (await postJson("/api/account", { displayName: "ひと" })).body;
      const joined = await postJson("/api/join-bot", {
        secret,
        bot: "g0",
        botDeck: "fudin",
        deckPreset: "doraparuto",
      });
      expect(joined.body.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const socket = new WebSocket(
        `ws://${worker.host}/ws?seatToken=${joined.body.seat.seatToken}`,
      );
      const sync = await new Promise<ServerMessage>((resolve) => {
        socket.on("message", (raw) => resolve(JSON.parse(String(raw)) as ServerMessage));
      });
      socket.close();
      if (sync.t !== "sync") throw new Error(`最初に sync が来なかった: ${sync.t}`);
      // 人の番から始まった対戦は、人が指すまで動いていない。
      if (sync.legalMoves !== null && sync.stateVersion === 0) continue;
      versionOnAttach = sync.stateVersion;
    }
    expect(versionOnAttach).toBeGreaterThan(0);
  });
});
