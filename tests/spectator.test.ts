/**
 * 観戦（`docs/spec/battle-server.md` 3.6 節）。
 *
 * 観戦者へ出る値そのものの漏洩は `leak.test.ts` が見る。ここで見るのは配線である。
 * 観戦トークンで座席に就けないこと、観戦者から局面を動かせないこと、上限と、その数え直し。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MAX_SPECTATORS, MAX_SPECTATORS_PER_MATCH, MatchHub, type SeatSocket } from "../src/hub.js";
import { concede } from "../src/match.js";
import { MatchRegistry } from "../src/registry.js";
import { startWorker, type TestWorker } from "./worker.js";
import { ensureCards, legalDecks, newMatch } from "./helpers.js";

let worker: TestWorker;
let base: string;

beforeAll(async () => {
  ensureCards();
  worker = await startWorker({ ACCOUNT_BURST: "0" });
  base = worker.host;
});

afterAll(async () => {
  await worker.close();
});

type Json = Record<string, any>;

async function postJson(path: string, body: unknown): Promise<Json> {
  const response = await fetch(`http://${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Json;
}

/** 1 局ぶんの座席トークンを、座席の順で返す。 */
async function seatTokens(room: string): Promise<[string, string]> {
  const deck = legalDecks()[0];
  const first = await postJson("/api/account", { displayName: "さき" });
  const waiting = await postJson("/api/join", { secret: first.secret, deck, roomCode: room });
  const second = await postJson("/api/account", { displayName: "あと" });
  const seated = await postJson("/api/join", { secret: second.secret, deck, roomCode: room });
  const claimed = (await (
    await fetch(`http://${base}/api/claim?ticket=${encodeURIComponent(waiting.ticket as string)}`)
  ).json()) as Json;
  const tokens: [string, string] = ["", ""];
  for (const seat of [claimed.seat, seated.seat] as { seat: 0 | 1; seatToken: string }[]) {
    tokens[seat.seat] = seat.seatToken;
  }
  return tokens;
}

interface Opened {
  socket: WebSocket;
  closed: Promise<void>;
  /** まだ読んでいない 1 通を、届いた順に返す。 */
  next(): Promise<Json>;
}

/** 繋いで、受け手を先に置く。席に就いた時点でサーバが 1 通送るので、あとから置くと取りこぼす。 */
async function connect(query: string): Promise<Opened> {
  const socket = new WebSocket(`ws://${base}/ws?${query}`);
  const seen: Json[] = [];
  socket.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Json));
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  let read = 0;
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  return {
    socket,
    closed,
    next: async () => {
      for (let waited = 0; waited < 300; waited += 1) {
        if (read < seen.length) return seen[read++]!;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("1 通も返ってこなかった");
    },
  };
}

const seatQuery = (token: string): string => `seatToken=${encodeURIComponent(token)}`;
const watchQuery = (token: string): string => `spectatorToken=${encodeURIComponent(token)}`;

/** 座席 2 つに就き、`sync` を読んだところで返す。観戦トークンは座席の `sync` から取る。 */
async function seatedPair(room: string): Promise<{
  seats: [Opened, Opened];
  syncs: [Json, Json];
  spectatorToken: string;
}> {
  const tokens = await seatTokens(room);
  const seats: [Opened, Opened] = [
    await connect(seatQuery(tokens[0])),
    await connect(seatQuery(tokens[1])),
  ];
  const syncs: [Json, Json] = [await seats[0].next(), await seats[1].next()];
  expect(syncs[0].t).toBe("sync");
  expect(syncs[0].spectatorToken).toBe(syncs[1].spectatorToken);
  return { seats, syncs, spectatorToken: syncs[0].spectatorToken as string };
}

describe("観戦の配線", () => {
  it("座席に配った観戦トークンで入ると、手を持たない局面が届く", async () => {
    const { seats, spectatorToken } = await seatedPair("かんせん-はいる");
    const watcher = await connect(watchQuery(spectatorToken));
    const sync = await watcher.next();

    expect(sync.t).toBe("spectator-sync");
    expect(sync.view.viewer).toBe("spectator");
    // 座席向けの欄を運ばない。手を持たず、seed の照合にも使わない。
    expect(sync).not.toHaveProperty("legalMoves");
    expect(sync).not.toHaveProperty("seat");
    expect(sync).not.toHaveProperty("seedCommit");
    expect(sync).not.toHaveProperty("matchId");
    // 名前は出すが、対局ログと人を結び付ける公開 id は出さない。
    expect(sync.seats.map((seat: Json) => seat.displayName)).toEqual(["さき", "あと"]);
    for (const seat of sync.seats as Json[]) expect(seat).not.toHaveProperty("playerId");

    for (const opened of [watcher, ...seats]) opened.socket.close();
  });

  it("座席の 1 手が、同じ版番号で観戦者へ届く", async () => {
    const { seats, syncs, spectatorToken } = await seatedPair("かんせん-てがとどく");
    const watcher = await connect(watchQuery(spectatorToken));
    expect((await watcher.next()).t).toBe("spectator-sync");

    const mover = syncs[0].legalMoves === null ? 1 : 0;
    seats[mover].socket.send(
      JSON.stringify({ t: "move", stateVersion: 0, move: syncs[mover].legalMoves[0] }),
    );
    const delta = await watcher.next();
    expect(delta.t).toBe("spectator-delta");
    expect(delta.stateVersion).toBe(1);
    expect(delta.view.viewer).toBe("spectator");
    expect(delta).not.toHaveProperty("legalMoves");
    expect((await seats[mover].next()).stateVersion).toBe(1);

    for (const opened of [watcher, ...seats]) opened.socket.close();
  });

  it("観戦している接続からは指せず、投了もできない", async () => {
    const { seats, syncs, spectatorToken } = await seatedPair("かんせん-させない");
    const watcher = await connect(watchQuery(spectatorToken));
    await watcher.next();

    const mover = syncs[0].legalMoves === null ? 1 : 0;
    watcher.socket.send(
      JSON.stringify({ t: "move", stateVersion: 0, move: syncs[mover].legalMoves[0] }),
    );
    expect((await watcher.next()).t).toBe("error");
    watcher.socket.send(JSON.stringify({ t: "concede" }));
    expect((await watcher.next()).t).toBe("error");
    watcher.socket.send(JSON.stringify({ t: "setup", active: "c0", bench: [] }));
    expect((await watcher.next()).t).toBe("error");

    // 局面も決着も動いていない。
    seats[0].socket.send(JSON.stringify({ t: "hello" }));
    const again = await seats[0].next();
    expect(again.t).toBe("sync");
    expect(again.stateVersion).toBe(0);

    for (const opened of [watcher, ...seats]) opened.socket.close();
  });

  it("観戦トークンでは座席に就けず、座席トークンでは観戦に入れない", async () => {
    const { seats, spectatorToken } = await seatedPair("かんせん-とりちがえ");
    const seatToken = (await seatTokens("かんせん-とりちがえ-2"))[0];

    for (const query of [
      seatQuery(spectatorToken),
      watchQuery(seatToken),
      // 両方を名乗る接続は、どちらとしても扱わない。
      `${seatQuery(seatToken)}&${watchQuery(spectatorToken)}`,
      "",
    ]) {
      const opened = await connect(query);
      await opened.closed;
    }

    for (const opened of seats) opened.socket.close();
  });

  it("決着を観戦者へ伝え、seed は明かさない", async () => {
    const { seats, spectatorToken } = await seatedPair("かんせん-けっちゃく");
    const watcher = await connect(watchQuery(spectatorToken));
    await watcher.next();

    seats[0].socket.send(JSON.stringify({ t: "concede" }));
    const ended = await watcher.next();
    expect(ended.t).toBe("spectator-ended");
    expect(ended.matchResult).toEqual({ kind: "concede", winner: 1, conceded: 0 });
    expect(ended).not.toHaveProperty("seed");
    expect(ended).not.toHaveProperty("seedNonce");
    expect(ended.view.viewer).toBe("spectator");
    // 伝えたらサーバが閉じる。開いたままだと、上限に数えられない接続が溜まる。
    await watcher.closed;

    // 終わった対戦はレジストリを離れるので、同じ観戦トークンでは入れない。
    const late = await connect(watchQuery(spectatorToken));
    expect((await late.next()).t).toBe("error");
    await late.closed;

    for (const opened of [watcher, ...seats]) opened.socket.close();
  });

  it("1 対戦の上限を越えた観戦者を断り、抜けたぶんは次の人が入れる", async () => {
    const { seats, spectatorToken } = await seatedPair("かんせん-うわかぎ");
    const watchers: Opened[] = [];
    for (let index = 0; index < MAX_SPECTATORS_PER_MATCH; index += 1) {
      const watcher = await connect(watchQuery(spectatorToken));
      expect((await watcher.next()).t).toBe("spectator-sync");
      watchers.push(watcher);
    }

    const over = await connect(watchQuery(spectatorToken));
    expect((await over.next()).t).toBe("error");
    await over.closed;

    const leaving = watchers.pop()!;
    leaving.socket.close();
    await leaving.closed;
    /**
     * サーバが閉じたことを知るのと、こちらが閉じ終わるのと、どちらが先かは決まっていない。
     * 知る前に繋げば断られるので、入れるまで繋ぎ直す。**入れないまま終われば落ちる。**
     */
    let replacement: Opened | null = null;
    for (let attempt = 0; attempt < 50 && replacement === null; attempt += 1) {
      const candidate = await connect(watchQuery(spectatorToken));
      if ((await candidate.next()).t === "spectator-sync") replacement = candidate;
      else await candidate.closed;
    }
    expect(replacement).not.toBeNull();

    for (const opened of [replacement!, ...watchers, ...seats]) opened.socket.close();
  });
});

/** 送った文字列を溜めるだけの接続。 */
function fakeSocket(): SeatSocket & { sent: Json[]; closed: boolean } {
  const socket = {
    sent: [] as Json[],
    closed: false,
    send: (data: string) => socket.sent.push(JSON.parse(data) as Json),
    close: () => {
      socket.closed = true;
    },
  };
  return socket;
}

describe("先攻", () => {
  // 先攻を決めた `game-started` は対戦を作るときに出て、delta には載らない。画面が先攻を出すには sync が要る。
  it("座席と観戦者の sync に、エンジンが決めた先攻が載る", () => {
    ensureCards();
    const registry = new MatchRegistry();
    const hub = new MatchHub({ registry, now: () => 0 });
    const matches = Array.from({ length: 8 }, (_, index) => newMatch(`hub-first-${index}`));
    // 先攻が座席 0 に決まり続けても通ってしまわないよう、両方の先攻を含める。
    expect(new Set(matches.map((match) => match.firstPlayer))).toEqual(new Set([0, 1]));

    for (const match of matches) {
      registry.add(match);
      const seats = [fakeSocket(), fakeSocket()];
      seats.forEach((socket, index) => hub.attach(socket, match.seatTokens[index]!));
      const watcher = fakeSocket();
      hub.attachSpectator(watcher, match.spectatorToken);
      for (const socket of [...seats, watcher]) {
        expect(socket.sent[0]!.firstPlayer).toBe(match.firstPlayer);
      }
    }
  });
});

describe("サーバ全体の観戦者の上限", () => {
  it("溢れたら断り、終わった対戦の観戦者は閉じて数から外す", () => {
    ensureCards();
    const registry = new MatchRegistry();
    const hub = new MatchHub({ registry, now: () => 0 });
    const matches = Array.from(
      { length: Math.ceil(MAX_SPECTATORS / MAX_SPECTATORS_PER_MATCH) + 1 },
      (_, index) => newMatch(`hub-watch-${index}`),
    );
    for (const match of matches) registry.add(match);

    const firstWatchers: ReturnType<typeof fakeSocket>[] = [];
    let attached = 0;
    for (const match of matches) {
      for (let index = 0; index < MAX_SPECTATORS_PER_MATCH && attached < MAX_SPECTATORS; index++) {
        const socket = fakeSocket();
        expect(hub.attachSpectator(socket, match.spectatorToken)).toBe(true);
        if (match === matches[0]) firstWatchers.push(socket);
        attached += 1;
      }
    }
    const spare = matches.at(-1)!;
    const over = fakeSocket();
    expect(hub.attachSpectator(over, spare.spectatorToken)).toBe(false);
    expect(over.sent.map((message) => message.t)).toEqual(["error"]);

    // 抜けた観戦者のぶんは、ほかの対戦の観戦者が使える。
    hub.detach(firstWatchers.pop()!);
    expect(hub.attachSpectator(fakeSocket(), spare.spectatorToken)).toBe(true);
    expect(hub.attachSpectator(fakeSocket(), spare.spectatorToken)).toBe(false);

    // 数から外し忘れると、観戦者のいた対戦が終わるたびに枠が減り、やがて誰も観戦できなくなる。
    const first = matches[0]!;
    expect(concede(first, 0, 0)).toBe(true);
    hub.endMatch(first);
    expect(firstWatchers.every((socket) => socket.closed)).toBe(true);
    expect(firstWatchers.every((socket) => socket.sent.at(-1)?.t === "spectator-ended")).toBe(true);
    expect(hub.attachSpectator(fakeSocket(), spare.spectatorToken)).toBe(true);
  });
});
