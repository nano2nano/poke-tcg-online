/**
 * マッチング（HTTP）と対戦（WebSocket）を 1 つのサーバへ組み立てる
 * （`docs/spec/battle-server.md` 3 節、7 節）。
 *
 * サーバからのプッシュが要るのは対戦が始まってからで、マッチングは要求と応答で足りる。
 * 起動そのものは `src/main.ts` が行う。ここを関数に切ってあるのは、
 * 通しのテストが同じ組み立てを任意のポートで立ち上げられるようにするためである。
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
import { AccountStore, type Account } from "./accounts.js";
import { findMatch, frameAt, isMatchId, listMatches, replayability } from "./history.js";
import { DEFAULT_LOG_DIR } from "./log.js";
import { scoreForSeatZero } from "./match.js";
import type { ClientMessage } from "./protocol.js";
import { MatchRegistry } from "./registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 持ち時間のスイープ。手番側が考えている限り時計は進むので、定期に見る必要がある。 */
export const TIMEOUT_SWEEP_MS = 5_000;

/** 要求の本文の上限。デッキ 60 枚の JSON で足りる大きさに抑える。 */
const MAX_BODY_BYTES = 64 * 1024;

export interface AppOptions {
  /** 対局ログの保存先。既定は `data/matches/`。 */
  logDir?: string;
  /** アカウントストアの保存先。既定は `data/`。 */
  accountDir?: string;
  now?: () => number;
}

export interface App {
  http: Server;
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  accounts: AccountStore;
  close(): Promise<void>;
}

export function createApp(options: AppOptions = {}): App {
  const now = options.now ?? (() => Date.now());
  const logDir = options.logDir ?? DEFAULT_LOG_DIR;
  const registry = new MatchRegistry(logDir);
  const accounts = new AccountStore(options.accountDir);
  const lobby = new Lobby(registry, accounts, now);
  // レーティングはログが落ちたあとに動かす。記録に残るのは対戦を始めた時点の値である（7.2 節）。
  const hub = new MatchHub({
    registry,
    now,
    onFinish: (record) => {
      accounts.applyResult(
        [record.seats[0].playerId, record.seats[1].playerId],
        scoreForSeatZero(record.matchResult),
        now(),
      );
    },
  });

  const http = createServer((request, response) => {
    route(request, response, lobby, accounts, now, logDir).catch((error: unknown) => {
      /**
       * **外へ出してよい文言は `BadRequest` に載っているものだけである。**
       * 例外の `message` をそのまま返していたときは、エンドポイントを 1 つ足すたびに
       * `Cannot read properties of null` のような内部の文言が漏れる箇所も 1 つ増えていた。
       * 読む人に意味が無いうえ、実装の中身をそのまま見せることになる。
       */
      if (error instanceof BadRequest) {
        respondJson(response, 400, { error: error.message });
        return;
      }
      console.warn(`${request.method ?? "?"} ${request.url ?? "?"} で落ちた:`, error);
      respondJson(response, 500, { error: "サーバ側で落ちた" });
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
    accounts,
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
  accounts: AccountStore,
  now: () => number,
  logDir: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  // 済んだ対戦の一覧とリプレイ。どちらも自分が指した対戦しか返さない（6.6 節）。
  if (request.method === "POST" && url.pathname === "/api/matches") {
    const account = await accountFromBody(request, accounts);
    if (account === null) {
      respondJson(response, 404, { code: ACCOUNT_NOT_FOUND, error: "アカウントが見つからない" });
      return;
    }
    respondJson(response, 200, { matches: listMatches(logDir, account.playerId) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/replay") {
    const body = (await readBody(request)) as {
      secret?: unknown;
      matchId?: unknown;
      ply?: unknown;
    };
    const account = typeof body.secret === "string" ? accounts.bySecret(body.secret) : null;
    if (account === null) {
      respondJson(response, 404, { code: ACCOUNT_NOT_FOUND, error: "アカウントが見つからない" });
      return;
    }
    // 形を確かめてから走査に入る。名指しになっていない値で全部の日を読まない（6.6 節）。
    const matchId = typeof body.matchId === "string" && isMatchId(body.matchId) ? body.matchId : "";
    const record = matchId === "" ? null : findMatch(logDir, account.playerId, matchId);
    if (record === null) {
      // 指していない対戦と、存在しない対戦を、同じ応答にする。
      respondJson(response, 404, { error: "対戦が見つからない" });
      return;
    }
    // カードの定義が変わっていれば、誤りを出さずに違う盤面を見せることになる（§6.3）。
    const readable = replayability(record);
    if (readable.kind === "card-data-mismatch") {
      respondJson(response, 409, {
        error: "この対戦は、いまとは違うカードデータで指されている。読み返せない。",
        recorded: readable.expected,
        current: readable.actual,
      });
      return;
    }
    const ply = typeof body.ply === "number" ? body.ply : 0;
    respondJson(response, 200, { seats: record.seats, frame: frameAt(record, ply) });
    return;
  }

  // プレイヤーを作る。シークレットを返すのはこの 1 度だけで、サーバは控えを持たない（7.2 節）。
  if (request.method === "POST" && url.pathname === "/api/account") {
    const body = (await readBody(request)) as { displayName?: unknown };
    const displayName = typeof body.displayName === "string" ? body.displayName : "";
    respondJson(response, 200, accounts.create(displayName, now()));
    return;
  }
  // 自分の戦績を見る。シークレットは本文で受け取る。URL に載せるとログや履歴に残る。
  if (request.method === "POST" && url.pathname === "/api/account/me") {
    const body = (await readBody(request)) as { secret?: unknown };
    const account = typeof body.secret === "string" ? accounts.bySecret(body.secret) : null;
    if (account === null) {
      respondJson(response, 404, { code: ACCOUNT_NOT_FOUND, error: "アカウントが見つからない" });
      return;
    }
    respondJson(response, 200, account);
    return;
  }
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
    const deck = toDeckList(await readBody(request));
    const errors = validateDeck(deck).map(describeViolation);
    respondJson(response, 200, { ok: errors.length === 0, errors });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/join") {
    const outcome = lobby.join(toJoinRequest(await readBody(request)));
    respondJson(response, outcome.ok ? 200 : 400, outcome);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/claim") {
    respondJson(response, 200, lobby.claim(url.searchParams.get("ticket") ?? ""));
    return;
  }
  serveStatic(url.pathname, response);
}

const MALFORMED = "送られた中身の形が違う";

/** アカウントが見つからないことを、画面の文言に頼らずに伝える合図。 */
export const ACCOUNT_NOT_FOUND = "account-not-found";

/** 外へ出してよいエラー応答。これ以外の例外は、文言を外へ出さない。 */
class BadRequest extends Error {}

/**
 * 外から来た本文をデッキへ直す。**形の合わないものはエンドポイントの入口で落とす。**
 * 素通りさせると中身を触った先で落ち、その場の例外メッセージ（`filter is not a function` など）が
 * そのまま外へ出る。読む人に意味が無く、内側の作りだけが分かる。
 */
/**
 * **要求そのものの形が違うことと、中身が規則に反することを、別の答えにする。**
 * 形が違うのは送り手の誤りなので `error` 1 本で断る。`ok` と `errors` は
 * 「そのデッキはこの点で成立しない」を並べるためのもので、読む人が直せる話である。
 */
function toDeckList(body: unknown): DeckList {
  if (typeof body !== "object" || body === null) throw new BadRequest(MALFORMED);
  const { cards } = body as Record<string, unknown>;
  if (!Array.isArray(cards) || cards.some((card) => typeof card !== "string")) {
    throw new BadRequest(MALFORMED);
  }
  return { cards: cards as DeckList["cards"] };
}

/** 外から来た本文を `JoinRequest` へ直す。省ける欄は、あれば形を確かめる。 */
function toJoinRequest(body: Record<string, unknown>): JoinRequest {
  const { secret, deck, displayName, roomCode } = body;
  if (typeof secret !== "string") throw new BadRequest(MALFORMED);
  if (displayName !== undefined && typeof displayName !== "string") throw new BadRequest(MALFORMED);
  if (roomCode !== undefined && typeof roomCode !== "string") throw new BadRequest(MALFORMED);
  return {
    secret,
    deck: toDeckList(deck),
    ...(displayName === undefined ? {} : { displayName }),
    ...(roomCode === undefined ? {} : { roomCode }),
  };
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

/** 本文の `secret` からプレイヤーを引く。シークレットを URL に載せないのはログと履歴に残るためである。 */
async function accountFromBody(
  request: IncomingMessage,
  accounts: AccountStore,
): Promise<Account | null> {
  const body = (await readBody(request)) as { secret?: unknown };
  return typeof body.secret === "string" ? accounts.bySecret(body.secret) : null;
}

/**
 * 本文を読む。**返すのは必ず object である。**
 *
 * `null` は JSON として正しいので `JSON.parse` は通る。そのまま返していたときは、
 * 各エンドポイントの `body.secret` が落ちて、その例外の文言が外へ出ていた。
 * 形の検査をエンドポイントごとに足すと足し忘れが残るので、ここで一度だけ通す。
 */
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest("要求の本文が大きすぎる");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BadRequest(MALFORMED);
  }
  if (typeof parsed !== "object" || parsed === null) throw new BadRequest(MALFORMED);
  return parsed as Record<string, unknown>;
}
