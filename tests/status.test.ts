/**
 * 自動のデプロイが待つかどうかを決める数（`docs/deploy.md`）。0 と答えた直後に Durable Object が
 * 入れ替わってよい、という約束である。
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AccountStore } from "../src/accounts.js";
import type { MatchArchive } from "../src/archive.js";
import { concede } from "../src/match.js";
import { ensureCards, newMatch } from "./helpers.js";

describe("/api/status", () => {
  it("決着を R2 へ置き終わるまで答えない", async () => {
    ensureCards();
    let settle: () => void = () => {};
    const settling = new Promise<void>((resolve) => (settle = resolve));
    const app = createApp({
      accounts: {} as AccountStore,
      archive: { settle: () => settling, settled: () => settling } as unknown as MatchArchive,
      accountLimit: null,
    });
    const match = newMatch("status");
    app.registry.add(match);
    concede(match, 0, 0);
    app.registry.retire(match);

    let answered = false;
    const response = app
      .fetch(new Request("http://localhost/api/status"), "test")
      .then((result) => {
        answered = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // レジストリからは離れているが、記録はまだメモリにしか無い。
    expect(answered).toBe(false);

    settle();
    expect(await (await response).json()).toEqual({ liveMatches: 0 });
  });
});
