/**
 * Cloudflare Workers への載せ方（`docs/spec/battle-server.md` 3.1 節）。
 *
 * 画面（`public/`）は静的アセットとして配り、Worker はそこを通らない。Worker が受けるのは
 * `/api/` と `/ws` だけで、カードの画像のほかは Durable Object `Server` の 1 つへ回す。
 * 生きている対戦はその 1 つのメモリにあり、終わった対戦は R2 と D1 へ残す。
 */

import type {
  D1Database,
  DurableObjectNamespace,
  DurableObjectState,
  R2Bucket,
  WebSocket as WorkerSocket,
  WebSocketPair as WebSocketPairConstructor,
} from "@cloudflare/workers-types/index.ts";
import { AccountStore } from "./accounts.js";
import {
  createApp,
  optionsFromVars,
  TICK_MS,
  type App,
  type AppSocket,
  type AppVars,
  type Connection,
} from "./app.js";
import { MatchArchive } from "./archive.js";
import { cardImageRoute } from "./card-image.js";
import { ensureSchema } from "./database.js";
import { registerPoolCards } from "./engine.js";

declare const WebSocketPair: typeof WebSocketPairConstructor;

export interface Env extends AppVars {
  SERVER: DurableObjectNamespace;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  /** `official` のときだけ、公式のカード画像へ転送する（3.7 節）。 */
  CARD_IMAGES?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 画像は盤面を描くたびにカードの枚数ぶん頼まれる。対戦の状態に触れないので、
    // すべての対戦が載っている Durable Object へは回さない。
    const image = await cardImageRoute(request, env.CARD_IMAGES === "official");
    if (image !== null) return image;
    // 対戦サーバは 1 つだけ置く。同じ部屋の 2 人が別の場所に着くと出会えない。
    const server = env.SERVER.get(env.SERVER.idFromName("main"));
    return (await server.fetch(request as never)) as unknown as Response;
  },
};

let cardsRegistered = false;

/** アラームの間隔。置くたびに書き込み 1 行と数えられるので、降ろされるまでの 70 秒に収まる範囲で長く取る。 */
const HOLD_MS = 60_000;

export class Server {
  private readonly app: App;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 置いたアラームが鳴る時刻。鳴るまでは置き直さない。置くたびに書き込みに数えられる。 */
  private alarmAt: number | null = null;

  constructor(
    private readonly state: DurableObjectState,
    env: Env,
  ) {
    if (!cardsRegistered) {
      registerPoolCards();
      cardsRegistered = true;
    }
    const accounts = new AccountStore(env.DB);
    const archive = new MatchArchive(env.DB, env.ARCHIVE, accounts);
    this.app = createApp({
      accounts,
      archive,
      ...optionsFromVars(env),
    });
    // 表が揃うまでは要求を受けない。揃ってから、書き損ねた対戦を拾う。
    void state.blockConcurrencyWhile(async () => {
      await ensureSchema(env.DB);
      archive.reconcile().catch((error: unknown) => {
        console.error("対局ログと索引を突き合わせられなかった:", error);
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const response = this.accept(request, url);
      this.keepTicking();
      return response;
    }
    // Cloudflare が付ける接続元のアドレス。送り手には書き換えられない。
    const origin = request.headers.get("cf-connecting-ip") ?? "unknown";
    const response = await this.app.fetch(request, origin);
    // 対戦を始める要求のあとに、時計を回し始める。
    this.keepTicking();
    return response;
  }

  /**
   * 定期処理は、見るものがある間だけ回す（3.1 節）。タイマーが残っていると、誰もいなくても
   * 稼働時間として数えられ、手元の workerd ではメモリから降ろせなくもなる。
   */
  private keepTicking(): void {
    if (this.app.idle()) return;
    if (this.alarmAt === null) void this.holdInMemory();
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.app.tick();
      } catch (error) {
        console.error("定期処理で落ちた:", error);
      }
      if (!this.app.idle()) {
        // 置けなかったアラームを、ここで置き直す。
        if (this.alarmAt === null) void this.holdInMemory();
      } else if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }, TICK_MS);
  }

  /**
   * 対戦が残っている間、アラームを置き続ける（3.1 節）。両方の座席が切れても、対戦をメモリから消さないためである。
   * 上の定期処理のタイマーは、Durable Object をメモリから降ろさない理由に数えられない。
   */
  private async holdInMemory(): Promise<void> {
    const at = Date.now() + HOLD_MS;
    this.alarmAt = at;
    try {
      await this.state.storage.setAlarm(at);
    } catch (error) {
      this.alarmAt = null;
      console.error("アラームを置けなかった:", error);
    }
  }

  async alarm(): Promise<void> {
    this.alarmAt = null;
    // 入れ替わったあとに鳴ることもある。そのときは対戦が無いので、置き直さない。
    this.keepTicking();
  }

  private accept(request: Request, url: URL): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket で繋ぐこと", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    let connection: Connection | null;
    try {
      connection = this.app.connect(url.searchParams, wrap(server));
    } catch (error) {
      console.error("接続を座席に就けられなかった:", error);
      server.close(1011, "internal error");
      return new Response(null, { status: 101, webSocket: client } as ResponseInit);
    }
    if (connection !== null) {
      server.addEventListener("message", (event) => {
        try {
          connection.receive(
            typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data),
          );
        } catch (error) {
          // 1 通の処理で投げても、ほかの接続と対戦は止めない。
          console.error("届いた 1 通を処理できなかった:", error);
        }
      });
      server.addEventListener("close", () => connection.closed());
      server.addEventListener("error", () => connection.closed());
    }
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }
}

/** 閉じた接続へ送っても投げさせない。相手が先に閉じているのは普通のことである。 */
function wrap(socket: WorkerSocket): AppSocket {
  return {
    send: (data) => {
      try {
        socket.send(data);
      } catch {
        // 閉じたあとの送信。受け手はもういない。
      }
    },
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // すでに閉じている。
      }
    },
  };
}
