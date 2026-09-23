/**
 * マッチング（HTTP）と対戦（WebSocket）を 1 つのサーバへ組み立てる
 * （`docs/spec/battle-server.md` 3 節、7 節）。
 *
 * サーバからのプッシュが要るのは対戦が始まってからで、マッチングは要求と応答で足りる。
 * ここは Workers の API に触れない。Durable Object への載せ方は `src/worker.ts` にある。
 */

import type { ZodType } from "zod";
import { cardIndexJson } from "./card-index.js";
import { describeViolation, validateDeck } from "./deck.js";
import { describeDecklistFailure, resolveDecklist } from "./decklist.js";
import { sampleDeck } from "./sample-deck.js";
import { MatchHub, type SeatSocket } from "./hub.js";
import { Lobby } from "./lobby.js";
import { ACCOUNT_NOT_FOUND, type AccountStore } from "./accounts.js";
import type { MatchArchive } from "./archive.js";
import { frameAt, isMatchId, replayability } from "./history.js";
import { clientMessageSchema } from "./protocol.js";
import {
  createAccountSchema,
  deckListSchema,
  joinRequestSchema,
  replayRequestSchema,
  resolveDecklistSchema,
  secretRequestSchema,
} from "./requests.js";
import { MatchRegistry } from "./registry.js";
import { RateLimit, type RateLimitOptions } from "./ratelimit.js";

export { ACCOUNT_NOT_FOUND };

/** 持ち時間のスイープ。手番側が考えている限り時計は進むので、定期に見る必要がある。 */
export const TICK_MS = 5_000;

/** 要求の本文と、WebSocket の 1 通の上限。デッキ 60 枚の JSON で足りる大きさに抑える。 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * この長さのあいだ 1 通も来ない接続を切る（3.5 節）。画面は 20 秒ごとに `ping` を送る。
 *
 * **短くしすぎない。** Chrome は 5 分より長く隠れたタブのタイマーを 1 分に 1 回へ間引くので、
 * 別のタブで相手の手番を待っている人の `ping` は 1 分おきになる。詰まっているだけで、
 * 待てば戻る接続も切ることになる。切られた側は繋ぎ直せる（3.3 節）が、そのあいだも時計は流れる（3.4 節）。
 * 見つけたいのは戻ってこない接続だけである。
 */
export const SILENCE_LIMIT_MS = 150_000;

/**
 * プレイヤーを作る速さの上限（7.2 節）。送信元 1 つにつき、続けて `burst` 回まで作れ、
 * そのあとは `refillMs` ごとに 1 回ぶん戻る。
 *
 * 止まるのは 1 か所から回す形だけで、送信元を変えながら来るもの
 * （IPv6 なら 1 人でいくらでも変えられる）は止まらないし、待てばいくらでも作れる。
 * 本当に止めるには総数の上限か、使われていないプレイヤーを消すエンドポイントが要る。10 節に残す。
 */
export const DEFAULT_ACCOUNT_LIMIT: RateLimitOptions = {
  burst: 20,
  refillMs: 10_000,
  origins: 4_096,
};

/** 作る間隔が短すぎることの合図。 */
export const TOO_MANY_ACCOUNTS = "too-many-accounts";

const MALFORMED = "送られた中身の形が違う";

export interface AppOptions {
  accounts: AccountStore;
  archive: MatchArchive;
  now?: () => number;
  /** アカウントを作れる速さ。`null` なら掛けない。 */
  accountLimit?: RateLimitOptions | null;
  /** 黙ったままの接続を切るまでの長さ。既定は `SILENCE_LIMIT_MS`。 */
  silenceLimitMs?: number;
}

/** 接続 1 本。Worker の WebSocket をこの形に包んで渡す（`src/worker.ts`）。 */
export interface AppSocket extends SeatSocket {
  close(code?: number, reason?: string): void;
}

/** 就いた接続に届いたものを渡す先。 */
export interface Connection {
  receive(data: string): void;
  closed(): void;
}

export interface App {
  lobby: Lobby;
  registry: MatchRegistry;
  hub: MatchHub;
  /** `/api/` の要求に答える。`origin` は送信元の見分けで、作る速さの上限に使う。 */
  fetch(request: Request, origin: string): Promise<Response>;
  /** `/ws` の検索部から、接続を座席か観戦へ就ける。就けなければ接続を閉じて null を返す。 */
  connect(params: URLSearchParams, socket: AppSocket): Connection | null;
  /** 定期処理。持ち時間の尽きた対戦を終わらせ、黙ったままの接続を切る。 */
  tick(): void;
  /** 定期処理で見るものが無い。対戦も、開いた接続も無い。 */
  idle(): boolean;
}

/** 配置先で変えられる設定。`wrangler.jsonc` の `vars` に置く。 */
export interface AppVars {
  /** プレイヤーを作る速さの上限を変えるときだけ置く。`0` なら掛けない。 */
  ACCOUNT_BURST?: string;
  /** 黙ったままの接続を切るまでのミリ秒。テストが待たずに済むように置く。 */
  SILENCE_LIMIT_MS?: string;
}

/**
 * `vars` を読む。読めない値では既定に倒し、警告を残す。 読めない上限を「掛けない」に倒すと、
 * 書き損じ 1 つで上限が黙って外れる。`NaN` の沈黙時間は、全部の接続を毎回切る。
 */
export function optionsFromVars(
  vars: AppVars,
): Pick<AppOptions, "accountLimit" | "silenceLimitMs"> {
  const options: Pick<AppOptions, "accountLimit" | "silenceLimitMs"> = {};
  const burst = readCount("ACCOUNT_BURST", vars.ACCOUNT_BURST);
  if (burst !== null)
    options.accountLimit = burst === 0 ? null : { ...DEFAULT_ACCOUNT_LIMIT, burst };
  const silence = readCount("SILENCE_LIMIT_MS", vars.SILENCE_LIMIT_MS);
  if (silence !== null && silence > 0) options.silenceLimitMs = silence;
  else if (silence === 0) console.warn("SILENCE_LIMIT_MS は 1 以上にする。既定を使う。");
  return options;
}

/** 0 以上の整数として読む。置いていないか読めなければ null。 */
function readCount(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const count = Number(value);
  if (Number.isInteger(count) && count >= 0) return count;
  console.warn(`${name} は 0 以上の整数で指定する。"${value}" は読めないので既定を使う。`);
  return null;
}

export function createApp(options: AppOptions): App {
  const now = options.now ?? (() => Date.now());
  const { accounts, archive } = options;
  const registry = new MatchRegistry();
  const lobby = new Lobby(registry, accounts, now);
  const limitOptions =
    options.accountLimit === undefined ? DEFAULT_ACCOUNT_LIMIT : options.accountLimit;
  const accountLimit = limitOptions === null ? null : new RateLimit(limitOptions);
  const silenceLimitMs = options.silenceLimitMs ?? SILENCE_LIMIT_MS;
  // レーティングは記録が残ったあとに動かす。記録に残るのは対戦を始めた時点の値である（7.2 節）。
  const hub = new MatchHub({
    registry,
    now,
    onFinish: (record) => void archive.settle(record),
  });
  /** 接続 → 最後に何か届いた時刻。 */
  const lastHeard = new Map<AppSocket, number>();
  const connections = new Map<AppSocket, Connection>();

  return {
    lobby,
    registry,
    hub,
    fetch: async (request, origin) => {
      try {
        return await route(request, origin, { lobby, accounts, archive, now, accountLimit });
      } catch (error) {
        /**
         * **外へ出してよい文言は `BadRequest` に載っているものだけである。**
         * 例外の `message` をそのまま返していたときは、エンドポイントを 1 つ足すたびに
         * `Cannot read properties of null` のような内部の文言が漏れる箇所も 1 つ増えていた。
         * 読む人に意味が無いうえ、実装の中身をそのまま見せることになる。
         */
        if (error instanceof BadRequest) return json(400, { error: error.message });
        console.warn(`${request.method} ${new URL(request.url).pathname} で落ちた:`, error);
        return json(500, { error: "サーバ側で落ちた" });
      }
    },
    connect: (params, socket) => {
      const connection = connectionOf(params);
      const attached =
        connection?.kind === "seat"
          ? hub.attach(socket, connection.token, connection.seedShare)
          : connection?.kind === "spectator" && hub.attachSpectator(socket, connection.token);
      if (connection === null || !attached) {
        socket.close();
        return null;
      }
      lastHeard.set(socket, now());
      const handle: Connection = {
        receive: (data) => {
          lastHeard.set(socket, now());
          /**
           * **大きすぎる 1 通は、その接続だけを閉じる**（3.5 節）。座席に就いた相手は、
           * 対戦が終わるまでいくらでもこちらへ送れる。運ぶのは 1 手と、その手を見せた位置だけである。
           */
          if (tooLarge(data)) {
            handle.closed();
            socket.close(1009, "too large");
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            socket.send(JSON.stringify({ t: "error", message: "JSON として読めない" }));
            return;
          }
          // 形を見てから配る。`null` 1 通でも、配った先で `t` を読んで落ちる。
          const message = clientMessageSchema.safeParse(parsed);
          if (!message.success) {
            socket.send(JSON.stringify({ t: "error", message: MALFORMED }));
            return;
          }
          if (connection.kind === "seat") hub.handle(socket, connection.token, message.data);
          else hub.handleSpectator(socket, connection.token, message.data);
        },
        closed: () => {
          lastHeard.delete(socket);
          connections.delete(socket);
          hub.detach(socket);
        },
      };
      connections.set(socket, handle);
      return handle;
    },
    tick: () => {
      // 持ち時間の側で投げても、黙った接続は切る。切らないと接続が残り続け、定期処理も止まらない。
      try {
        hub.sweepTimeouts();
      } catch (error) {
        console.error("持ち時間を見られなかった:", error);
      }
      /**
       * **閉じるだけでなく、こちらで席から外す。** 線の向こうが消えていると、閉じる合図の
       * 返事が来ないので `close` も届かない。外さないと、その接続は座席に就いたまま残る。
       */
      const nowMs = now();
      for (const [socket, heard] of lastHeard) {
        if (nowMs - heard < silenceLimitMs) continue;
        connections.get(socket)?.closed();
        socket.close(1001, "silent");
      }
    },
    idle: () => registry.idle() && lastHeard.size === 0,
  };
}

interface RouteContext {
  lobby: Lobby;
  accounts: AccountStore;
  archive: MatchArchive;
  now: () => number;
  accountLimit: RateLimit | null;
}

async function route(request: Request, origin: string, context: RouteContext): Promise<Response> {
  const { lobby, accounts, archive, now, accountLimit } = context;
  const url = new URL(request.url);

  // 済んだ対戦の一覧とリプレイ。どちらも自分が指した対戦しか返さない（6.6 節）。
  if (request.method === "POST" && url.pathname === "/api/matches") {
    const { secret } = parseBody(secretRequestSchema, await readBody(request));
    const account = await accounts.find(secret);
    if (account === null) return accountNotFound();
    return json(200, { matches: await archive.list(account.playerId) });
  }
  if (request.method === "POST" && url.pathname === "/api/replay") {
    const body = parseBody(replayRequestSchema, await readBody(request));
    const account = await accounts.find(body.secret);
    if (account === null) return accountNotFound();
    // 形になっていない識別子で D1 と R2 を読みに行かない。
    const record = isMatchId(body.matchId)
      ? await archive.find(account.playerId, body.matchId)
      : null;
    // 指していない対戦と、存在しない対戦を、同じ応答にする。
    if (record === null) return json(404, { error: "対戦が見つからない" });
    // 断らずに読むと、誤りを出さずに違う盤面を見せることになる（§6.3、§6.4）。
    const readable = replayability(record);
    if (readable.kind === "schema-too-old") {
      return json(409, {
        error: "この対戦は、いまとは違う乱数で指されている。読み返せない。",
        recorded: readable.recorded,
        oldestReplayable: readable.oldest,
      });
    }
    if (readable.kind === "seed-commitment-mismatch") {
      return json(409, {
        error: "この対戦は、記録された種が公開された値と合わない。読み返せない。",
      });
    }
    if (readable.kind === "card-data-mismatch") {
      return json(409, {
        error: "この対戦は、いまとは違うカードデータで指されている。読み返せない。",
        recorded: readable.expected,
        current: readable.actual,
      });
    }
    return json(200, { seats: record.seats, frame: frameAt(record, body.ply ?? 0) });
  }

  // プレイヤーを作る。シークレットを返すのはこの 1 度だけで、サーバは控えを持たない（7.2 節）。
  if (request.method === "POST" && url.pathname === "/api/account") {
    const body = parseBody(createAccountSchema, await readBody(request));
    /**
     * **作った覚えの無いものが際限なく増えないようにする。** プレイヤーを消すエンドポイントは無い。
     * 本文を先に読むのは、形の違う要求で枠を使わせないためである。
     */
    if (accountLimit !== null && !accountLimit.take(origin, now())) {
      return json(429, {
        code: TOO_MANY_ACCOUNTS,
        error: "プレイヤーを作る間隔が短すぎる。少し待ってからもう一度どうぞ。",
      });
    }
    return json(200, await accounts.create(body.displayName ?? "", now()));
  }
  // 自分の戦績を見る。シークレットは本文で受け取る。URL に載せるとログや履歴に残る。
  if (request.method === "POST" && url.pathname === "/api/account/me") {
    const { secret } = parseBody(secretRequestSchema, await readBody(request));
    // 画面は決着のすぐあとにこれを読み直す。レーティングが動き終わってから答える。
    await archive.settled();
    const account = await accounts.find(secret);
    return account === null ? accountNotFound() : json(200, account);
  }
  if (request.method === "GET" && url.pathname === "/api/cards") {
    return jsonText(200, cardIndexJson());
  }
  if (request.method === "GET" && url.pathname === "/api/sample-deck") {
    return json(200, sampleDeck());
  }
  // 人が書いた文字列を `defId` の列へ直す（5.3 節）。同じ名前が複数あるときは候補を返す。
  if (request.method === "POST" && url.pathname === "/api/deck/resolve") {
    const { text } = parseBody(resolveDecklistSchema, await readBody(request));
    const resolved = resolveDecklist(text);
    if (!resolved.ok) {
      return json(200, {
        ok: false,
        errors: resolved.failures.map(describeDecklistFailure),
        failures: resolved.failures,
      });
    }
    // 形として読めても、デッキとして成立しているとは限らない。続けて構築の検査も掛ける。
    const errors = validateDeck(resolved.deck).map(describeViolation);
    return json(200, {
      ok: errors.length === 0,
      errors,
      deck: resolved.deck,
      entries: resolved.entries,
    });
  }
  if (request.method === "POST" && url.pathname === "/api/deck/validate") {
    const deck = parseBody(deckListSchema, await readBody(request));
    const errors = validateDeck(deck).map(describeViolation);
    return json(200, { ok: errors.length === 0, errors });
  }
  if (request.method === "POST" && url.pathname === "/api/join") {
    const body = parseBody(joinRequestSchema, await readBody(request));
    // 前の対戦のレーティングが動き終わってから席に着ける。記録に残るのは始めた時点の値である。
    await archive.settled();
    const outcome = lobby.join(body, await accounts.find(body.secret));
    return json(outcome.ok ? 200 : 400, outcome);
  }
  if (request.method === "GET" && url.pathname === "/api/claim") {
    return json(200, lobby.claim(url.searchParams.get("ticket") ?? ""));
  }
  return json(404, { error: "not found" });
}

/**
 * 両方のトークンを名乗る接続は断る。どちらかを優先すると、観戦のつもりで開いた画面が
 * 座席トークンも持っていたときに、黙って手を指せる接続になる。
 */
function connectionOf(
  params: URLSearchParams,
):
  | { kind: "seat"; token: string; seedShare: string | null }
  | { kind: "spectator"; token: string }
  | null {
  const seatToken = params.get("seatToken");
  const spectatorToken = params.get("spectatorToken");
  if (seatToken !== null && spectatorToken === null) {
    return { kind: "seat", token: seatToken, seedShare: params.get("seedShare") };
  }
  if (spectatorToken !== null && seatToken === null) {
    return { kind: "spectator", token: spectatorToken };
  }
  return null;
}

/** 外へ出してよいエラー応答。これ以外の例外は、文言を外へ出さない。 */
class BadRequest extends Error {}

/**
 * 本文をスキーマに通す。**形が違えば、内側の文言を出さずに断る。**
 *
 * 素通りさせると中身を触った先で落ち、その場の例外メッセージ（`filter is not a function`
 * など）がそのまま外へ出る。読む人に意味が無く、内側の作りだけが分かる。
 *
 * **要求そのものの形が違うことと、中身が規則に反することは、別の答えにする。**
 * 形が違うのは送り手の誤りなので `error` 1 本で断る。`ok` と `errors` は
 * 「そのデッキはこの点で成立しない」を並べるためのもので、読む人が直せる話である。
 */
function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const outcome = schema.safeParse(body);
  if (!outcome.success) throw new BadRequest(MALFORMED);
  return outcome.data;
}

function json(status: number, body: unknown): Response {
  return jsonText(status, JSON.stringify(body));
}

function jsonText(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function accountNotFound(): Response {
  return json(404, { code: ACCOUNT_NOT_FOUND, error: "アカウントが見つからない" });
}

/**
 * 本文を読む。**大きさだけを見て、形は見ない。**
 *
 * 形は `parseBody` がスキーマで見る（`requests.ts`）。上限はここでしか見られない
 * （読み切る前に切る必要がある）ので、それだけを見る。
 */
async function readBody(request: Request): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new BadRequest("要求の本文が大きすぎる");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new BadRequest(MALFORMED);
  }
}

/** UTF-8 にして上限を越えるか。UTF-16 の 1 単位は多くて 3 バイトなので、長さだけで決まるときは数えない。 */
function tooLarge(text: string): boolean {
  if (text.length * 3 <= MAX_BODY_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES;
}
