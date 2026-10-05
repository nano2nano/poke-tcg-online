/** AI どうしの対戦を立てて見る（`docs/spec/battle-server.md` 7.4 節）。 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountStore } from "../src/accounts.js";
import { botFromBytes, presetDeck, type Bot } from "../src/bots.js";
import { encodePpoWeights, newPpoWeightsFile, type DeckList } from "../src/engine.js";
import { MatchHub, type SeatSocket } from "../src/hub.js";
import { BOT_WATCH_FULL, BOT_WATCH_LIMIT, BOT_WATCH_LIVE, Lobby } from "../src/lobby.js";
import type { MatchRecord } from "../src/log.js";
import { concede, viewFor, type Match } from "../src/match.js";
import type { ServerMessage } from "../src/protocol.js";
import { MatchRegistry } from "../src/registry.js";
import { ensureCards, startTossed } from "./helpers.js";
import { startStorage } from "./worker.js";

vi.setConfig({ testTimeout: 30_000 });

let storage: Awaited<ReturnType<typeof startStorage>>;
let bot: Bot;
let decks: [DeckList, DeckList];

beforeAll(async () => {
  ensureCards();
  storage = await startStorage();
  bot = botFromBytes("g0", encodePpoWeights(newPpoWeightsFile("test-bot")));
  decks = [presetDeck("dragapult-28731")!, presetDeck("alakazam-dudunsparce-72073")!];
});

afterAll(async () => {
  await storage.close();
});

interface Arena {
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  accounts: AccountStore;
  finished: MatchRecord[];
}

function newArena(): Arena {
  const registry = new MatchRegistry();
  const accounts = new AccountStore(storage.db);
  const finished: MatchRecord[] = [];
  return {
    registry,
    accounts,
    finished,
    lobby: new Lobby(registry, accounts),
    hub: new MatchHub({
      registry,
      botDelayMs: 0,
      watchDelayMs: 0,
      onFinish: (record) => finished.push(record),
    }),
  };
}

/** 立てた対戦と、その観戦トークン。動かすのは呼び手である。 */
async function opened(arena: Arena): Promise<{ match: Match; spectatorToken: string }> {
  const { account } = await arena.accounts.create("見る人", 0);
  const outcome = arena.lobby.watchBots(account, [bot, bot], decks);
  if (!outcome.ok) throw new Error(outcome.errors.join(" "));
  const match = arena.registry.bySpectatorToken(outcome.spectatorToken);
  if (match === undefined) throw new Error("立てた対戦が始まっていない");
  return { match, spectatorToken: outcome.spectatorToken };
}

function spectator(): { socket: SeatSocket; messages: ServerMessage[]; ended: Promise<void> } {
  const messages: ServerMessage[] = [];
  let resolve = () => {};
  const ended = new Promise<void>((done) => (resolve = done));
  const socket: SeatSocket = {
    send: (data) => void messages.push(JSON.parse(data) as ServerMessage),
    close: resolve,
  };
  return { socket, messages, ended };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AI どうしの対戦", () => {
  it("見る人が繋ぐと動き出し、誰も指さずに決着まで進む", async () => {
    const arena = newArena();
    const { match, spectatorToken } = await opened(arena);
    const watcher = spectator();
    arena.hub.wakeWatch(spectatorToken);
    arena.hub.attachSpectator(watcher.socket, spectatorToken);
    await watcher.ended;

    const record = arena.finished.at(-1);
    expect(record?.matchId).toBe(match.matchId);
    expect(record?.seats.map((seat) => seat.bot?.name)).toEqual(["g0", "g0"]);
    expect(record?.moves.every((move) => move.source === "bot")).toBe(true);
    expect(arena.registry.bySpectatorToken(spectatorToken)).toBeUndefined();
  });

  it("見る人が繋ぐまでは動かさない", async () => {
    const arena = newArena();
    const { match, spectatorToken } = await opened(arena);
    arena.hub.wakeWatch(spectatorToken);
    await pause(30);
    expect(match.version).toBe(0);

    arena.hub.attachSpectator(spectator().socket, spectatorToken);
    await pause(30);
    expect(match.version).toBeGreaterThan(0);
    concede(match, 0, 0);
    arena.hub.endMatch(match);
  });

  it("観戦者へ両座席の射影と、指された手を 1 手ずつ届ける", async () => {
    const arena = newArena();
    const { match, spectatorToken } = await opened(arena);
    const watcher = spectator();
    arena.hub.attachSpectator(watcher.socket, spectatorToken);
    const [sync] = watcher.messages;
    expect(sync?.t === "spectator-sync" && sync.seatViews).toEqual([
      viewFor(match, 0),
      viewFor(match, 1),
    ]);
    await watcher.ended;

    const deltas = watcher.messages.filter((message) => message.t === "spectator-delta");
    const record = arena.finished.at(-1)!;
    expect(deltas.map((delta) => delta.moved?.move)).toEqual(record.moves.map(({ move }) => move));
    for (const delta of deltas) {
      expect(delta.seatViews?.map((view) => view.viewer)).toEqual([0, 1]);
      // 手札の中身が、座席の側の射影として両座席ぶん届く。
      expect(delta.seatViews?.every((view) => Array.isArray(view.self.hand))).toBe(true);
    }
    const ended = watcher.messages.at(-1);
    expect(ended?.t === "spectator-ended" && ended.seatViews?.length).toBe(2);
  });

  it("同じ AI どうしは、表示名で卓のどちらか見分けられる", async () => {
    const arena = newArena();
    const { match } = await opened(arena);
    expect(match.seats.map((seat) => seat.displayName)).toEqual(["AI g0（1）", "AI g0（2）"]);
    concede(match, 0, 0);
    arena.hub.endMatch(match);
  });
});

describe("AI どうしの対戦を立てる", () => {
  it("立てた対戦が終わるまでは次を立てず、その観戦トークンを返す", async () => {
    const arena = newArena();
    const { account } = await arena.accounts.create("見る人", 0);
    const first = arena.lobby.watchBots(account, [bot, bot], decks);
    if (!first.ok) throw new Error(first.errors.join(" "));
    const again = arena.lobby.watchBots(account, [bot, bot], decks);
    expect(again).toMatchObject({
      ok: false,
      code: BOT_WATCH_LIVE,
      spectatorToken: first.spectatorToken,
    });

    const match = arena.registry.bySpectatorToken(first.spectatorToken)!;
    concede(match, 0, 0);
    arena.hub.endMatch(match);
    expect(arena.lobby.watchBots(account, [bot, bot], decks).ok).toBe(true);
  });

  it("重みを読んでいるあいだは、同じ人の次の要求を断る", async () => {
    const arena = newArena();
    const { account } = await arena.accounts.create("見る人", 0);
    arena.lobby.holdWatch(account.playerId);
    expect(arena.lobby.refuseWatch(account, decks)).toMatchObject({ code: BOT_WATCH_LIVE });
    arena.lobby.releaseWatch(account.playerId);
    expect(arena.lobby.refuseWatch(account, decks)).toBeNull();
  });

  it("サーバ全体で上限まで動いていれば断る", async () => {
    const arena = newArena();
    for (let index = 0; index < BOT_WATCH_LIMIT; index++) await opened(arena);
    const { account } = await arena.accounts.create("見る人", 0);
    expect(arena.lobby.watchBots(account, [bot, bot], decks)).toMatchObject({
      ok: false,
      code: BOT_WATCH_FULL,
    });
  });

  it("人が座る対戦の観戦者には、座席の射影も指された手も届かない", async () => {
    const arena = newArena();
    const { account, secret } = await arena.accounts.create("ひと", 0);
    const joined = arena.lobby.joinBot({ secret, deck: decks[0] }, account, bot, decks[1]);
    if (!joined.ok || !("seat" in joined)) throw new Error("AI と対戦できなかった");
    startTossed(arena.registry);
    const { seatToken } = joined.seat;
    const match = arena.registry.bySeatToken(seatToken)!.match;
    const watcher = spectator();
    arena.hub.attachSpectator(watcher.socket, match.spectatorToken);
    // 人の座席は、局面を見せ終えたと知らせ、届いた合法手の先頭を次の番で指す。
    const human: SeatSocket = {
      send(data) {
        const message = JSON.parse(data) as ServerMessage;
        if (message.t !== "sync" && message.t !== "delta") return;
        const stateVersion = message.stateVersion;
        setTimeout(() => arena.hub.handle(human, seatToken, { t: "shown", stateVersion }), 0);
        const move = message.legalMoves?.[0];
        if (move === undefined) return;
        setTimeout(() => arena.hub.handle(human, seatToken, { t: "move", stateVersion, move }), 0);
      },
      close() {},
    };
    arena.hub.attach(human, seatToken);
    await watcher.ended;

    expect(match.moves.some((move) => move.source === "human")).toBe(true);
    expect(match.moves.some((move) => move.source === "bot")).toBe(true);
    for (const message of watcher.messages) {
      expect(message).not.toHaveProperty("seatViews");
      expect(message).not.toHaveProperty("moved");
    }
  });
});
