/**
 * AI と、本物のサーバを通して 1 局指す（`docs/spec/battle-server.md` 7.3 節）。
 *
 * 重みの読み込みはエンジンの Node 向けのコード（`Buffer`、`node:crypto`）を通る。
 * Worker の上で読めることは、Worker を起こさないと確かめられない。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { INITIAL_RATING } from "../src/accounts.js";
import { BOT_PREFIX } from "../src/bots.js";
import { encodePpoWeights, isBasicPokemon, newPpoWeightsFile } from "../src/engine.js";
import type { MatchRecord } from "../src/log.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { basicEnergyDefId, ensureCards, legalDecks } from "./helpers.js";
import { startWorker, type TestWorker } from "./worker.js";

let worker: TestWorker;

beforeAll(async () => {
  ensureCards();
  worker = await startWorker({ ACCOUNT_BURST: "0", BOT_DELAY_MS: "0", WATCH_DELAY_MS: "0" });
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

/** 人の座席で合法手の先頭を返し続け、決着の 1 通を返す。 */
async function playToEnd(seatToken: string): Promise<ServerMessage> {
  const socket = new WebSocket(`ws://${worker.host}/ws?seatToken=${seatToken}`);
  const ended = await new Promise<ServerMessage>((resolve) => {
    socket.on("message", (raw) => {
      const message = JSON.parse((raw as Buffer).toString()) as ServerMessage;
      if (message.t === "ended") resolve(message);
      // AI との対戦で始まる前に届くコイントスは、人が勝ったときだけである。
      if (message.t === "pending" && message.toss !== null) {
        socket.send(JSON.stringify({ t: "turn-order", first: true } satisfies ClientMessage));
      }
      if (message.t !== "sync" && message.t !== "delta") return;
      const shown: ClientMessage = { t: "shown", stateVersion: message.stateVersion };
      socket.send(JSON.stringify(shown));
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
  return ended;
}

async function recordOf(playerId: string): Promise<MatchRecord | undefined> {
  const { objects } = await worker.archive.list({ prefix: "matches/" });
  const records: MatchRecord[] = [];
  for (const { key } of objects) {
    records.push(JSON.parse(await (await worker.archive.get(key))!.text()) as MatchRecord);
  }
  return records.find((each) => each.seats[0].playerId === playerId);
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
      expect(deck.aces.length, deck.label).toBeGreaterThan(0);
      for (const ace of deck.aces) expect(cards[ace]?.name, deck.label).toEqual(expect.any(String));
    }
    // 名前が重なると、選択肢のどれがどのデッキか画面で見分けられない。
    const names = (decks as JsonBody[]).map((deck) =>
      deck.aces.map((ace: string) => cards[ace].name).join("・"),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("置いていない AI は断る", async () => {
    const { secret } = (await postJson("/api/account", { displayName: "ひと" })).body;
    const outcome = await postJson("/api/join-bot", {
      secret,
      bot: "not-there",
      botDeck: "alakazam-dudunsparce-72073",
      deckPreset: "dragapult-28731",
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body.ok).toBe(false);
  });

  it("人が合法手を返すだけで決着まで進み、記録には AI の手と重みが残る", async () => {
    const { secret, account } = (await postJson("/api/account", { displayName: "ひと" })).body;
    const joined = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "alakazam-dudunsparce-72073",
      deckPreset: "dragapult-28731",
    });
    expect(joined.body.ok).toBe(true);
    expect((await playToEnd(joined.body.seat.seatToken)).t).toBe("ended");

    // 決着を残し終えてから読む。`/api/account/me` はレーティングが動き終わるのを待って答える。
    const me = (await postJson("/api/account/me", { secret })).body;
    expect(me).toMatchObject({ rating: INITIAL_RATING, games: 0 });
    const record = await recordOf(account.playerId);
    expect(record?.seats[1].bot).toMatchObject({ name: "g0", label: "test-bot", generation: 0 });
    expect(record?.moves.some((move) => move.source === "bot")).toBe(true);
    const listed = (await postJson("/api/matches", { secret })).body.matches as JsonBody[];
    expect(listed.map((summary) => summary.matchId)).toEqual([record?.matchId]);

    // 決着が付けば、次の AI との対戦を始められる。
    const next = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "alakazam-dudunsparce-72073",
      deckPreset: "dragapult-28731",
    });
    expect(next.body.ok).toBe(true);
    // 続いているあいだは断り、その席を返す。
    const refused = await postJson("/api/join-bot", {
      secret,
      bot: "g0",
      botDeck: "alakazam-dudunsparce-72073",
      deckPreset: "dragapult-28731",
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "bot-match-live", seat: next.body.seat });
  });

  it("AI のデッキに組んだデッキを渡すと、そのデッキで決着まで指す。規則を通らなければ断る", async () => {
    const { secret, account } = (await postJson("/api/account", { displayName: "ひと" })).body;
    const built = (await (await fetch(`http://${worker.host}/api/sample-deck`)).json()) as JsonBody;
    const join = (botDeck: unknown) =>
      postJson("/api/join-bot", { secret, bot: "g0", botDeck, deckPreset: "dragapult-28731" });

    const refused = await join({ cards: [] });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBeUndefined();
    expect(refused.body.errors[0]).toMatch(/^AI のデッキ: /);

    const joined = await join(built);
    expect(joined.body.ok).toBe(true);
    expect((await playToEnd(joined.body.seat.seatToken)).t).toBe("ended");
    await postJson("/api/account/me", { secret });
    expect((await recordOf(account.playerId))?.decks[1]).toEqual(built);
  });

  /**
   * シェアを出さずに入り、AI がコイントスに勝てば、対戦は席を渡した時点で始まっている。準備で AI が先に選ぶ
   * 対戦では、人が繋ぐ前に AI が指していなければならない。AI が先になる対戦を引くまで開き直す。
   * AI は後攻を選ぶので、AI が先に選ぶのは人がたねを引けずに引き直すときである。人のデッキのたねは 1 枚にする。
   */
  it("AI が先に選ぶ対戦では、人が繋ぐ前に AI が指している", async () => {
    ensureCards();
    const basic = legalDecks()[0].cards.find((defId) => isBasicPokemon(defId))!;
    const deck = { cards: [basic, ...Array<string>(59).fill(basicEnergyDefId())] };
    let versionOnAttach: number | null = null;
    for (let attempt = 0; attempt < 16 && versionOnAttach === null; attempt++) {
      const { secret } = (await postJson("/api/account", { displayName: "ひと" })).body;
      const joined = await postJson("/api/join-bot", {
        secret,
        bot: "g0",
        botDeck: "alakazam-dudunsparce-72073",
        deck,
      });
      expect(joined.body.ok).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const socket = new WebSocket(
        `ws://${worker.host}/ws?seatToken=${joined.body.seat.seatToken}`,
      );
      const sync = await new Promise<ServerMessage>((resolve) => {
        socket.on("message", (raw) =>
          resolve(JSON.parse((raw as Buffer).toString()) as ServerMessage),
        );
      });
      socket.close();
      // 人がコイントスに勝った対戦は、人が選ぶまで始まっていない。
      if (sync.t === "pending") continue;
      if (sync.t !== "sync") throw new Error(`最初に sync が来なかった: ${sync.t}`);
      // 人の番から始まった対戦は、人が指すまで動いていない。
      if (sync.legalMoves !== null && sync.stateVersion === 0) continue;
      versionOnAttach = sync.stateVersion;
    }
    expect(versionOnAttach).toBeGreaterThan(0);
  });
});

describe("AI どうしの対戦を見る", () => {
  it("立てた対戦を観戦の接続で決着まで見られ、記録には両座席の AI が残る", async () => {
    const { secret } = (await postJson("/api/account", { displayName: "見る人" })).body;
    const request = {
      secret,
      bots: ["g0", "g0"],
      decks: ["dragapult-28731", "alakazam-dudunsparce-72073"],
    };
    const opened = await postJson("/api/watch-bots", request);
    expect(opened.body.ok).toBe(true);
    const { spectatorToken } = opened.body;
    // 終わるまでは次を立てず、立てた対戦の観戦トークンを返す。
    const refused = await postJson("/api/watch-bots", request);
    expect(refused.body).toMatchObject({ ok: false, code: "bot-watch-live", spectatorToken });

    const socket = new WebSocket(`ws://${worker.host}/ws?spectatorToken=${spectatorToken}`);
    const messages: ServerMessage[] = [];
    await new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        messages.push(JSON.parse((raw as Buffer).toString()) as ServerMessage);
      });
      socket.on("close", () => resolve());
    });
    const deltas = messages.filter((message) => message.t === "spectator-delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(
      deltas.every((delta) => delta.moved !== undefined && delta.seatViews !== undefined),
    ).toBe(true);
    expect(messages.at(-1)?.t).toBe("spectator-ended");

    // `/api/account/me` は記録を残し終えるのを待って答える。
    await postJson("/api/account/me", { secret });
    const { objects } = await worker.archive.list({ prefix: "matches/" });
    const records: MatchRecord[] = [];
    for (const { key } of objects) {
      records.push(JSON.parse(await (await worker.archive.get(key))!.text()) as MatchRecord);
    }
    const record = records.find((each) => each.seats.every((seat) => seat.bot?.name === "g0"));
    expect(record?.moves.length).toBe(deltas.length);
  });

  it("AI のデッキに組んだデッキを渡すと、そのデッキで決着まで指す。規則を通らなければ断る", async () => {
    const { secret } = (await postJson("/api/account", { displayName: "見る人" })).body;
    const built = (await (await fetch(`http://${worker.host}/api/sample-deck`)).json()) as JsonBody;
    const watch = (second: unknown) =>
      postJson("/api/watch-bots", {
        secret,
        bots: ["g0", "g0"],
        decks: ["dragapult-28731", second],
      });

    const refused = await watch({ cards: [] });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0]).toMatch(/^2 人目の AI のデッキ: /);

    const opened = await watch(built);
    expect(opened.body.ok).toBe(true);
    const socket = new WebSocket(
      `ws://${worker.host}/ws?spectatorToken=${opened.body.spectatorToken}`,
    );
    let last: ServerMessage | undefined;
    await new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        last = JSON.parse((raw as Buffer).toString()) as ServerMessage;
      });
      socket.on("close", () => resolve());
    });
    expect(last?.t).toBe("spectator-ended");

    await postJson("/api/account/me", { secret });
    const { objects } = await worker.archive.list({ prefix: "matches/" });
    const decks: unknown[] = [];
    for (const { key } of objects) {
      const record = JSON.parse(await (await worker.archive.get(key))!.text()) as MatchRecord;
      if (record.seats.every((seat) => seat.bot !== undefined)) decks.push(record.decks[1]);
    }
    expect(decks).toContainEqual(built);
  });
});
