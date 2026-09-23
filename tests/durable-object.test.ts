/**
 * Durable Object を降ろさせないためのアラーム（`docs/spec/battle-server.md` 3.1 節）。
 *
 * 本当に降ろされるかは Cloudflare の上でしか起きないので、ここで見るのは置き方だけである。
 * 対戦が残っている間は置き続け、無くなったら置き直さない。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types/index.ts";
import { concede } from "../src/match.js";
import { Server, type Env } from "../src/worker.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { startStorage } from "./worker.js";

let storage: Awaited<ReturnType<typeof startStorage>>;

beforeAll(async () => {
  ensureCards();
  storage = await startStorage();
});

afterAll(async () => {
  await storage.close();
});

function server() {
  const alarms: number[] = [];
  const state = {
    blockConcurrencyWhile: async (task: () => Promise<unknown>) => task(),
    storage: {
      setAlarm: async (at: number) => {
        alarms.push(at);
      },
    },
  } as unknown as DurableObjectState;
  const env = { DB: storage.db, ARCHIVE: storage.archive, ACCOUNT_BURST: "0" } as unknown as Env;
  const instance = new Server(state, env);
  const post = async (path: string, body: unknown) =>
    (await (
      await instance.fetch(
        new Request(`http://server${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    ).json()) as Record<string, any>;
  return {
    instance,
    alarms,
    post,
    ring: () => instance.alarm(),
  };
}

describe("対戦を保つアラーム", () => {
  it("対戦が始まれば置き、残っている間は鳴るたびに置き直し、無くなれば置かない", async () => {
    const { instance, alarms, post, ring } = server();
    const startMatch = async (room: string) => {
      for (const name of ["あ", "い"]) {
        const { secret } = await post("/api/account", { displayName: name });
        await post("/api/join", { secret, deck: legalDecks()[0], roomCode: room });
      }
    };
    const { registry } = (instance as unknown as { app: { registry: any } }).app;
    const finishAll = () => {
      for (const match of registry.live()) {
        concede(match, 0, 0);
        registry.retire(match);
      }
    };

    await startMatch("たもつ");
    expect(alarms).toHaveLength(1);
    // 鳴るまでは置き直さない。置くたびに書き込みに数えられる。
    await startMatch("もうひとつ");
    expect(alarms).toHaveLength(1);

    await ring();
    expect(alarms).toHaveLength(2);

    finishAll();
    await ring();
    expect(alarms).toHaveLength(2);

    /**
     * 定期処理のタイマーがまだ止まっていない間に次の対戦が始まっても、アラームを置く。
     * タイマーが回っていることを「置いてある」の代わりにすると、ここで置き忘れる。
     */
    await startMatch("つぎ");
    expect(alarms).toHaveLength(3);
    finishAll();
  });
});
