/**
 * 対戦の接続そのものに掛かる制限。**盤面の話ではなく、繋がりの話である。**
 *
 * 座席に就いた相手は、対戦が終わるまでいくらでもこちらへ送れる。何を受け取り、
 * どこで切るかを決めておかないと、盤面が正しくてもサーバが保たない。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, sweepDeadSockets, type App } from "../src/app.js";
import { ensureCards, legalDecks } from "./helpers.js";

let app: App;
let base: string;

beforeAll(async () => {
  ensureCards();
  const dir = mkdtempSync(join(tmpdir(), "poke-online-socket-"));
  // 見たいのは接続のほうなので、プレイヤーを作る速さの上限には当てない。
  app = createApp({ logDir: dir, accountDir: dir, accountLimit: null });
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", () => resolve()));
  const { port } = app.http.address() as AddressInfo;
  base = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(`http://${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, any>;
}

/**
 * 座席に就くまで。2 人ぶん入れないと対戦が始まらないので、両方を出す。
 * 席に就けた側のトークンを返す。試験ごとに別の部屋を使い、前の対戦の相手を拾わない。
 */
async function seatToken(room: string): Promise<string> {
  const deck = legalDecks()[0];
  for (const displayName of ["あ", "い"]) {
    const { secret } = await postJson("/api/account", { displayName });
    const outcome = await postJson("/api/join", { secret, deck, roomCode: room });
    if (outcome.seat !== undefined) return outcome.seat.seatToken as string;
  }
  throw new Error("座席に就けなかった");
}

describe("1 通の大きさ", () => {
  it("上限を超える 1 通で接続を切る", async () => {
    const socket = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("おおきすぎる")}`);
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));

    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    // `ws` の既定（100 MiB）のままなら、これは素通りして盤面に触る手前まで進む。
    socket.send("x".repeat(128 * 1024));

    // 1009 は「受け取った 1 通が大きすぎる」。切った理由が相手に伝わる形で落ちる。
    expect(await closed).toBe(1009);

    // **落ちるのはこの接続だけである。** 受け手のいない `error` は
    // プロセスごと落とすので、そうなれば指している全員の対戦が巻き添えになる。
    const next = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("まきぞえ")}`);
    const sync = new Promise<string>((resolve) =>
      next.on("message", (raw) => resolve(String(raw))),
    );
    expect(await sync).toContain('"t":"sync"');
    next.close();
  });

  it("上限までの 1 通は受け取る", async () => {
    const socket = new WebSocket(`ws://${base}/ws?seatToken=${await seatToken("じょうげん")}`);
    await new Promise<void>((resolve) => socket.on("open", () => resolve()));

    const answer = new Promise<string>((resolve) => {
      socket.on("message", (raw) => resolve(String(raw)));
      socket.on("close", (code) => resolve(`closed:${code}`));
    });
    // JSON として読めない中身なので、断りが返るのが正しい。切られてはいけない。
    socket.send("x".repeat(32 * 1024));

    expect(await answer).toContain("JSON として読めない");
    socket.close();
  });
});

describe("死活確認", () => {
  /** `ping` と `terminate` の呼ばれ方だけを見る。時間は動かさない。 */
  function fakeSocket(): { ping(): void; terminate(): void; pinged: number; killed: number } {
    return {
      pinged: 0,
      killed: 0,
      ping() {
        this.pinged += 1;
      },
      terminate() {
        this.killed += 1;
      },
    };
  }

  it("返事のあった接続へは次の ping を送る", () => {
    const socket = fakeSocket();
    const answered = new WeakSet([socket]);

    sweepDeadSockets([socket], answered);

    expect(socket.pinged).toBe(1);
    expect(socket.killed).toBe(0);
  });

  it("1 巡ぶん黙っている接続を切る", () => {
    const socket = fakeSocket();
    const answered = new WeakSet([socket]);

    // 1 巡目で ping を送り、返事が無いまま 2 巡目に入る。
    sweepDeadSockets([socket], answered);
    sweepDeadSockets([socket], answered);

    expect(socket.pinged).toBe(1);
    expect(socket.killed).toBe(1);
  });

  it("返事が来ていれば切らずに続ける", () => {
    const socket = fakeSocket();
    const answered = new WeakSet([socket]);

    sweepDeadSockets([socket], answered);
    answered.add(socket); // pong が届いた
    sweepDeadSockets([socket], answered);

    expect(socket.pinged).toBe(2);
    expect(socket.killed).toBe(0);
  });
});
