/**
 * 対戦の接続そのものに掛かる制限。**盤面の話ではなく、繋がりの話である。**
 *
 * 座席に就いた相手は、対戦が終わるまでいくらでもこちらへ送れる。何を受け取り、
 * どこで切るかを決めておかないと、盤面が正しくてもサーバが保たない。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startWorker, type TestWorker } from "./worker.js";
import { createApp, SILENCE_LIMIT_MS, type AppSocket } from "../src/app.js";
import type { AccountStore } from "../src/accounts.js";
import type { MatchArchive } from "../src/archive.js";
import { concede } from "../src/match.js";
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

async function postJson(path: string, body: unknown, host = base): Promise<Record<string, any>> {
  const response = await fetch(`http://${host}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

/**
 * 座席に就くまで。2 人ぶん入れないと対戦が始まらないので、両方を出す。
 * 席に就けた側のトークンを返す。テストごとに別のルームコードを使い、前の対戦の相手を拾わない。
 */
async function seatToken(room: string, host = base): Promise<string> {
  const deck = legalDecks()[0];
  for (const displayName of ["あ", "い"]) {
    const { secret } = await postJson("/api/account", { displayName }, host);
    const outcome = await postJson("/api/join", { secret, deck, roomCode: room }, host);
    if (outcome.seat !== undefined) return outcome.seat.seatToken as string;
  }
  throw new Error("座席に就けなかった");
}

describe("1 通の大きさ", () => {
  it("上限を超える 1 通で接続を切る", async () => {
    const socket = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("おおきすぎる")}`);
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));

    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    // 上限を置かなければ、これは素通りして盤面に触る手前まで進む。
    socket.send("x".repeat(128 * 1024));

    // 1009 は「受け取った 1 通が大きすぎる」。切った理由が相手に伝わる形で落ちる。
    expect(await closed).toBe(1009);

    // **落ちるのはこの接続だけである。** ほかの接続はそのまま繋がる。
    const next = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("まきぞえ")}`);
    const sync = new Promise<string>((resolve) =>
      next.on("message", (raw) => resolve(String(raw))),
    );
    expect(await sync).toContain('"t":"sync"');
    next.close();
  });

  it("上限までの 1 通は受け取る", async () => {
    const socket = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("じょうげん")}`);
    /**
     * **受け手は接続を作った直後に置く。** 席に就いた時点でサーバが `sync` を送るので、
     * `open` を待ってから置くと、その `sync` が先に着いたかどうかで結果が変わる。
     */
    const answer = new Promise<string>((resolve) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { t: string; message?: string };
        if (message.t === "error") resolve(message.message ?? "");
      });
      socket.on("close", (code) => resolve(`closed:${code}`));
    });
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));

    // JSON として読めない中身なので、エラーが返るのが正しい。切られてはいけない。
    socket.send("x".repeat(32 * 1024));

    expect(await answer).toContain("JSON として読めない");
    socket.close();
  });
});

/**
 * Cloudflare Workers ではサーバから ping を送れないので、画面が 20 秒ごとに `ping` を送り、
 * サーバは何も届かないまま `SILENCE_LIMIT_MS` が過ぎた接続を切る（3.5 節）。
 * 線の向こうが消えると `close` は届かないので、ここで切らないと座席に就いたまま残る。
 */
describe("黙ったままの接続", () => {
  /** 時計を手で進める。定期処理もこちらで呼ぶ。 */
  function arena() {
    let nowMs = 0;
    // 接続と定期処理しか使わないので、保存先は持たせない。
    const app = createApp({
      accounts: {} as AccountStore,
      archive: {} as MatchArchive,
      now: () => nowMs,
      accountLimit: null,
    });
    const match = newMatch("silence");
    app.registry.add(match);
    const socket: AppSocket & { closedWith: number | null } = {
      closedWith: null,
      send: () => {},
      close(code) {
        this.closedWith = code ?? 1000;
      },
    };
    const connection = app.connect(
      new URLSearchParams({ seatToken: match.seatTokens[0] }),
      socket,
    )!;
    return {
      app,
      socket,
      connection,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  function finish(app: ReturnType<typeof arena>["app"]): void {
    for (const match of app.registry.live()) {
      concede(match, 0, 0);
      app.registry.retire(match);
    }
  }

  it("何も届かないまま上限を過ぎた接続を切り、席から外す", () => {
    const { app, socket, advance } = arena();

    advance(SILENCE_LIMIT_MS - 1);
    app.tick();
    expect(socket.closedWith).toBeNull();

    advance(1);
    app.tick();
    expect(socket.closedWith).toBe(1001);
    // 切った接続は数えない。対戦が終われば、定期処理が見るものは無くなる。
    finish(app);
    expect(app.idle()).toBe(true);
  });

  it("持ち時間の側で投げても、黙った接続は切る", () => {
    const { app, socket, advance } = arena();
    app.hub.sweepTimeouts = () => {
      throw new Error("壊れた対戦");
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      advance(SILENCE_LIMIT_MS);
      app.tick();
    } finally {
      error.mockRestore();
    }
    expect(socket.closedWith).toBe(1001);
  });

  it("`ping` が届いていれば、何度上限を跨いでも切らない", () => {
    const { app, socket, connection, advance } = arena();

    for (let round = 0; round < 5; round++) {
      advance(SILENCE_LIMIT_MS - 1);
      connection.receive(JSON.stringify({ t: "ping" }));
      app.tick();
    }
    expect(socket.closedWith).toBeNull();
  });

  it("閉じた接続は、定期処理で見なくなる", () => {
    const { app, connection } = arena();
    expect(app.idle()).toBe(false);

    connection.closed();
    // 対戦はまだ生きているので、定期処理は止まらない。接続のぶんだけが外れる。
    expect(app.idle()).toBe(false);
    finish(app);
    expect(app.idle()).toBe(true);
  });

  /** ここまでは作りの中を見た。本物の Worker で、定期処理が本当に切るところまでを 1 度だけ見る。 */
  it("本物の Worker でも、黙った接続は切られる", async () => {
    const quick = await startWorker({ ACCOUNT_BURST: "0", SILENCE_LIMIT_MS: "500" });
    try {
      const socket = new WebSocket(
        `ws://${quick.host}/ws?seatToken=${await seatToken("だまる", quick.host)}`,
      );
      const code = await new Promise<number>((resolve) =>
        socket.on("close", (closed) => resolve(closed)),
      );
      expect(code).toBe(1001);
    } finally {
      await quick.close();
    }
  }, 30_000);
});
