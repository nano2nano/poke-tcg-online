/**
 * 待ち合わせ（HTTP）と対戦（WebSocket）を 1 つの口に組み立てる
 * （`docs/spec/battle-server.md` 3 節、7 節）。
 *
 * 押し出しが要るのは対戦が始まってからで、待ち合わせは要求と応答で足りる。
 * 起動そのものは `src/main.ts` が行う。ここを関数に切ってあるのは、
 * 通しの試験が同じ組み立てを任意の口で立ち上げられるようにするためである。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { DeckList } from "./engine.js";
import { cardIndex } from "./card-index.js";
import { describeViolation, validateDeck } from "./deck.js";
import { describeDecklistFailure, resolveDecklist } from "./decklist.js";
import { sampleDeck } from "./sample-deck.js";
import { MatchHub } from "./hub.js";
import { Lobby, type JoinRequest } from "./lobby.js";
import type { ClientMessage } from "./protocol.js";
import { MatchRegistry } from "./registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 持ち時間の掃き。手番側が考えている限り時計は進むので、定期に見る必要がある。 */
export const TIMEOUT_SWEEP_MS = 5_000;

/** 要求の本文の上限。デッキ 60 枚の JSON で足りる大きさに抑える。 */
const MAX_BODY_BYTES = 64 * 1024;

export interface AppOptions {
  /** 対局ログの置き場。既定は `data/matches/`。 */
  logDir?: string;
  now?: () => number;
}

export interface App {
  http: Server;
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  close(): Promise<void>;
}

export function createApp(options: AppOptions = {}): App {
  const registry = new MatchRegistry(options.logDir);
  const lobby = new Lobby(registry, options.now);
  const hub = new MatchHub(
    options.now === undefined ? { registry } : { registry, now: options.now },
  );

  const http = createServer((request, response) => {
    route(request, response, lobby).catch((error: unknown) => {
      respondJson(response, 400, { error: (error as Error).message });
    });
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const seatToken = new URL(request.url ?? "/", "http://localhost").searchParams.get("seatToken");
    if (seatToken === null || !hub.attach(socket, seatToken)) {
      socket.close();
      return;
    }
    socket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        socket.send(JSON.stringify({ t: "error", message: "JSON として読めない" }));
        return;
      }
      hub.handle(socket, seatToken, message);
    });
    socket.on("close", () => hub.detach(socket));
  });

  const sweep = setInterval(() => hub.sweepTimeouts(), TIMEOUT_SWEEP_MS);
  sweep.unref();

  return {
    http,
    lobby,
    registry,
    hub,
    close: async () => {
      clearInterval(sweep);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  lobby: Lobby,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/api/cards") {
    respondJson(response, 200, cardIndex());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/sample-deck") {
    respondJson(response, 200, sampleDeck());
    return;
  }
  // 人が書いた文字列を `defId` の列へ直す（5.3 節）。同じ名前が複数あるときは候補を返す。
  if (request.method === "POST" && url.pathname === "/api/deck/resolve") {
    const body = (await readBody(request)) as { text?: unknown };
    if (typeof body.text !== "string") {
      respondJson(response, 400, { ok: false, errors: ["デッキの文字列が要る"] });
      return;
    }
    const resolved = resolveDecklist(body.text);
    if (!resolved.ok) {
      respondJson(response, 200, {
        ok: false,
        errors: resolved.failures.map(describeDecklistFailure),
        failures: resolved.failures,
      });
      return;
    }
    // 形として読めても、デッキとして成立しているとは限らない。続けて構築の検査も掛ける。
    const errors = validateDeck(resolved.deck).map(describeViolation);
    respondJson(response, 200, {
      ok: errors.length === 0,
      errors,
      deck: resolved.deck,
      entries: resolved.entries,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/deck/validate") {
    const deck = (await readBody(request)) as DeckList;
    const errors = validateDeck(deck).map(describeViolation);
    respondJson(response, 200, { ok: errors.length === 0, errors });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/join") {
    const outcome = lobby.join((await readBody(request)) as JoinRequest);
    respondJson(response, outcome.ok ? 200 : 400, outcome);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/claim") {
    respondJson(response, 200, { seat: lobby.claim(url.searchParams.get("ticket") ?? "") });
    return;
  }
  serveStatic(url.pathname, response);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveStatic(pathname: string, response: ServerResponse): void {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // `..` を含む経路で public の外へ出られないようにする。
  const base = join(ROOT, "public");
  const resolved = join(base, normalize(relative));
  if (!resolved.startsWith(base)) {
    respondJson(response, 403, { error: "forbidden" });
    return;
  }
  try {
    const body = readFileSync(resolved);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream",
    });
    response.end(body);
  } catch {
    respondJson(response, 404, { error: "not found" });
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("要求の本文が大きすぎる");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
