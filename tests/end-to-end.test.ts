/**
 * 待ち合わせから決着まで、実際の HTTP と WebSocket を通して 1 局指す。
 *
 * 各層の試験が通っていても、配線が違えば人は 1 手も指せない。
 * ここだけは本物の口を開いて、外から見える経路だけで対戦を成立させる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type App } from "../src/app.js";
import { engineFingerprint } from "../src/fingerprint.js";
import type { MatchRecord } from "../src/log.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { replay } from "../src/replay.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { getCardDef, loadGeneratedCards } from "../src/engine.js";
import { sampleDeck } from "../src/sample-deck.js";

let app: App;
let base: string;
let logDir: string;

beforeAll(async () => {
  ensureCards();
  logDir = mkdtempSync(join(tmpdir(), "poke-online-e2e-"));
  app = createApp({ logDir });
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", () => resolve()));
  const { port } = app.http.address() as AddressInfo;
  base = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

/** 応答の形は試験の中でだけ広げて読む。サーバ側の型は `protocol.ts` が持つ。 */
type JsonBody = Record<string, any>;

async function postJson(path: string, body: unknown): Promise<JsonBody> {
  const response = await fetch(`http://${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as JsonBody;
}

async function getJson(path: string): Promise<JsonBody> {
  return (await (await fetch(`http://${base}${path}`)).json()) as JsonBody;
}

/**
 * 座席 1 つぶんのクライアント。届いた合法手から 1 つ選んで送り返すだけで、
 * 盤面の判断を一切持たない。**サーバが手番でない座席へ合法手を送らないので、
 * 2 つの座席が同時に指そうとすることは起きない。**
 */
function seatClient(seatToken: string, ended: (message: ServerMessage) => void): WebSocket {
  const socket = new WebSocket(`ws://${base}/ws?seatToken=${seatToken}`);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.t === "ended") {
      ended(message);
      return;
    }
    if (message.t !== "sync" && message.t !== "delta") return;
    const legal = message.legalMoves;
    if (legal === null || legal.length === 0) return;
    const move: ClientMessage = {
      t: "move",
      stateVersion: message.stateVersion,
      move: legal[0]!,
    };
    socket.send(JSON.stringify(move));
  });
  return socket;
}

/**
 * 見本のデッキを、人が書くのと同じ文字列へ起こす。**カードの名前を試験へ書き写さない**ため、
 * 名前は登録済みの定義から引く。同じ名前が複数あるときは `defId` を書き添える形にする。
 */
function sampleDecklistText(): string {
  const counts = new Map<string, number>();
  for (const defId of sampleDeck().cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);

  const shared = new Set<string>();
  const seen = new Set<string>();
  for (const def of loadGeneratedCards()) {
    if (seen.has(def.name)) shared.add(def.name);
    seen.add(def.name);
  }

  const lines: string[] = [];
  for (const [defId, count] of counts) {
    const { name } = getCardDef(defId);
    lines.push(shared.has(name) ? `${name} ${count} ${defId}` : `${name} ${count}`);
  }
  return lines.join("\n");
}

describe("人が書いたデッキ", () => {
  it("文字列で出したデッキが、そのまま対戦に使える形で返る", async () => {
    const outcome = await postJson("/api/deck/resolve", { text: sampleDecklistText() });

    expect(outcome.errors).toEqual([]);
    expect(outcome.ok).toBe(true);
    // 並びも含めて正本なので、枚数だけでなく列そのものを見る。
    expect(outcome.deck.cards).toEqual(sampleDeck().cards);
  });

  it("同じ名前が複数あるカードは、候補を返して拒否する", async () => {
    const shared = new Map<string, number>();
    for (const def of loadGeneratedCards()) {
      shared.set(def.name, (shared.get(def.name) ?? 0) + 1);
    }
    const ambiguous = [...shared.entries()]
      .filter(([, count]) => count > 1)
      .sort(([a], [b]) => (a < b ? -1 : 1))[0];
    if (ambiguous === undefined) throw new Error("重複する名前が無い");

    const outcome = await postJson("/api/deck/resolve", { text: `${ambiguous[0]} 4` });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0].kind).toBe("ambiguous");
    expect(outcome.failures[0].choices.length).toBe(ambiguous[1]);
  });

  it("デッキの文字列が無い要求を 400 で返す", async () => {
    const response = await fetch(`http://${base}/api/deck/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});

describe("待ち合わせから決着まで", () => {
  it("2 人が繋がり、1 局を最後まで指し、ログが再生できる", async () => {
    const deck = legalDecks()[0];
    const first = await postJson("/api/join", {
      playerId: "a",
      displayName: "あ",
      deck,
      roomCode: "とおし",
    });
    expect(first.ok).toBe(true);
    const second = await postJson("/api/join", {
      playerId: "b",
      displayName: "い",
      deck,
      roomCode: "とおし",
    });
    expect(second.seat.seat).toBe(1);

    const claimed = await getJson(`/api/claim?ticket=${first.ticket}`);
    expect(claimed.seat.seat).toBe(0);

    const endings: ServerMessage[] = [];
    const done = new Promise<void>((resolve) => {
      const finish = (message: ServerMessage): void => {
        endings.push(message);
        if (endings.length === 2) resolve();
      };
      seatClient(claimed.seat.seatToken, finish);
      seatClient(second.seat.seatToken, finish);
    });

    await done;
    for (const ending of endings) {
      expect(ending.t).toBe("ended");
      if (ending.t === "ended") expect(ending.matchResult.kind).toBe("normal");
    }

    // ログが 1 行落ちていて、そのまま再生できる。
    const files = readdirSync(logDir).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(logDir, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as MatchRecord;
    let initialCards: string[] = [];
    const result = replay(record, {
      fingerprint: engineFingerprint(),
      inspect: (state, index) => {
        if (index === 0) initialCards = initialCardIds(state);
        inspectState(state, initialCards);
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(record.moves.length);
    expect(record.moves.length).toBeGreaterThan(10);
  }, 60_000);
});
