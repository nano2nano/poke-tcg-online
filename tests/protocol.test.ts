/**
 * 座席から届く 1 通の形（`docs/spec/battle-server.md` 3.2 節）。
 *
 * **盤面の正しさとは別の話である。** 座席に就いた相手は対戦が終わるまで何度でも送れるので、
 * 形の違う 1 通で受け手が落ちれば、そのとき指していた全員の対戦が巻き添えになる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type App } from "../src/app.js";
import { ensureCards, legalDecks } from "./helpers.js";

let app: App;
let base: string;

beforeAll(async () => {
  ensureCards();
  const dir = mkdtempSync(join(tmpdir(), "poke-online-protocol-"));
  app = createApp({ logDir: dir, accountDir: dir, accountLimit: null });
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", () => resolve()));
  base = `127.0.0.1:${(app.http.address() as AddressInfo).port}`;
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

/** 1 局ぶんの座席トークンを、座席の順で返す。先に入ったほうはチケットから受け取る。 */
async function seatTokens(room: string): Promise<[string, string]> {
  const deck = legalDecks()[0];
  const first = await postJson("/api/account", { displayName: "さき" });
  const waiting = await postJson("/api/join", { secret: first.secret, deck, roomCode: room });
  const second = await postJson("/api/account", { displayName: "あと" });
  const seated = await postJson("/api/join", { secret: second.secret, deck, roomCode: room });
  const claimed = (await (
    await fetch(`http://${base}/api/claim?ticket=${encodeURIComponent(waiting.ticket as string)}`)
  ).json()) as Record<string, any>;
  const tokens: [string, string] = ["", ""];
  for (const seat of [claimed.seat, seated.seat] as { seat: 0 | 1; seatToken: string }[]) {
    tokens[seat.seat] = seat.seatToken;
  }
  return tokens;
}

interface Opened {
  socket: WebSocket;
  /** まだ読んでいない 1 通を、届いた順に返す。 */
  next(): Promise<Record<string, any>>;
}

/**
 * 座席へ繋ぎ、最初の `sync` まで読んだ接続を返す。
 *
 * **受け手は接続を作った直後に置き、読んだ位置を別に数える。** 席に就いた時点でサーバが
 * `sync` を送るので、`open` を待ってから置くと取りこぼす。「いま以降の 1 通」を待つ形でも、
 * すでに届いていたぶんを飛ばして次を待つので、同じところで止まる。
 */
async function open(seatToken: string): Promise<Opened> {
  const socket = new WebSocket(`ws://${base}/ws?seatToken=${encodeURIComponent(seatToken)}`);
  const seen: Record<string, any>[] = [];
  socket.on("message", (raw) => seen.push(JSON.parse(String(raw)) as Record<string, any>));
  let read = 0;
  const opened: Opened = {
    socket,
    next: async () => {
      for (let waited = 0; waited < 200; waited += 1) {
        if (read < seen.length) return seen[read++]!;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("1 通も返ってこなかった");
    },
  };
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  expect((await opened.next()).t).toBe("sync");
  return opened;
}

/**
 * 形の違う 1 通。**object でないもの、`t` が知らないもの、欄の型が違うもの**を並べる。
 *
 * 1 つずつ確かめるのではなく並べて送るのは、`/api/...` 側と同じ理由である。
 * 例を 1 つ足すやり方だと、次に足した欄がまた抜ける。
 */
const MALFORMED: unknown[] = [
  null,
  7,
  "ただの文字列",
  [1, 2, 3],
  {},
  { t: "しらない" },
  { t: "move" },
  { t: "move", stateVersion: 0 },
  { t: "move", stateVersion: "0", move: { type: "EndTurn" } },
  { t: "move", stateVersion: -1, move: { type: "EndTurn" } },
  { t: "move", stateVersion: 1.5, move: { type: "EndTurn" } },
  { t: "move", stateVersion: 0, move: null },
  { t: "move", stateVersion: 0, move: "EndTurn" },
  { t: "move", stateVersion: 0, move: [] },
  { t: "move", stateVersion: 0, move: { type: "EndTurn" }, offered: "ぜんぶ" },
  { t: "move", stateVersion: 0, move: { type: "EndTurn" }, offered: [-1] },
];

describe("座席から届く 1 通", () => {
  it("形の違う 1 通を断り、接続も対戦も落とさない", async () => {
    const opened = await open((await seatTokens("かたちがちがう"))[0]);

    for (const payload of MALFORMED) {
      opened.socket.send(JSON.stringify(payload));
      const answer = await opened.next();
      /**
       * **`null` の 1 通で落ちていた。** 読む側が `t` を見に行くので、`ws` の `message` の
       * 中で例外が上がる。受け手がいないので Node はプロセスごと落とし、そのとき指していた
       * 全員の対戦が巻き添えになる。ここで断らなければ、この行の前に落ちている。
       */
      expect(answer.t, JSON.stringify(payload)).toBe("error");
    }

    // **落ちていないことまで見る。** 断れていても、次の 1 通が通らなければ意味が無い。
    opened.socket.send(JSON.stringify({ t: "ping" }));
    expect((await opened.next()).t).toBe("pong");
    opened.socket.close();
  });

  it("通る 1 通は、これまでどおり答える", async () => {
    const opened = await open((await seatTokens("とおる"))[0]);

    opened.socket.send(JSON.stringify({ t: "hello" }));
    expect((await opened.next()).t).toBe("sync");
    opened.socket.send(JSON.stringify({ t: "ping" }));
    expect((await opened.next()).t).toBe("pong");
    opened.socket.close();
  });

  /**
   * **`hello` に載ってきた座席トークンで座席を決めない。**
   *
   * 座席は接続したときの `seatToken` で決まっている（3.3 節）。`hello` の欄を見て決め直すと、
   * 相手の座席トークンを 1 通送るだけで**相手の手札が見える**ことになる。
   */
  it("`hello` に相手の座席トークンを載せても、返ってくるのは自分の座席である", async () => {
    const [mine, theirs] = await seatTokens("すりかえ");
    const opened = await open(mine);

    opened.socket.send(JSON.stringify({ t: "hello", seatToken: theirs }));
    const answer = await opened.next();
    expect(answer.t).toBe("sync");
    expect(answer.seat).toBe(0);
    expect(answer.view.viewer).toBe(0);
    opened.socket.close();
  });
});
