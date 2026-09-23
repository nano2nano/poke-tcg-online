/**
 * テストから本物の Worker を起こす。
 *
 * 起こすのは `wrangler deploy` が出すのと同じ組み立てで、Durable Object も D1 も R2 も
 * ローカルの実装（workerd）で動く。サーバの配線はここを通してしか確かめられない。
 * D1 と R2 は Node の側からも触れるので、保存先を直に読むテストもここから始める。
 */

import type { D1Database, R2Bucket } from "@cloudflare/workers-types/index.ts";
import { createTestHarness } from "wrangler";
import { ensureSchema } from "../src/database.js";

export interface TestWorker {
  /** `127.0.0.1:<port>` の形。`http://` と `ws://` のどちらにも付けられる。 */
  host: string;
  db: D1Database;
  archive: R2Bucket;
  /** 生きている対戦ごと Durable Object をメモリから降ろす。保存したものは残る。 */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** `vars` は `wrangler.jsonc` の `vars` に重ねる。テストごとに上限の値を変えるのに使う。 */
export async function startWorker(vars: Record<string, string> = {}): Promise<TestWorker> {
  const harness = createTestHarness({
    workers: [{ configPath: new URL("../wrangler.jsonc", import.meta.url), vars }],
  });
  const { url } = await harness.listen();
  const worker = harness.getWorker();
  const env = (await worker.getEnv()) as { DB: D1Database; ARCHIVE: R2Bucket };
  // Durable Object が起きる前に Node の側から触るテストのために、表をここでも用意する。
  await ensureSchema(env.DB);
  return {
    host: url.host,
    db: env.DB,
    archive: env.ARCHIVE,
    restart: () => worker.evictDurableObject("Server", { name: "main", webSockets: "close" }),
    close: () => harness.close(),
  };
}

/** D1 と R2 だけを使うテストの足場。Worker は起こすが、要求は送らない。 */
export async function startStorage(): Promise<Pick<TestWorker, "db" | "archive" | "close">> {
  return startWorker();
}
