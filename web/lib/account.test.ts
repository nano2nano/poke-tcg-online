import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccount } from "./account.js";

let items: Map<string, string>;
const created = { secret: "新しいシークレット", account: { displayName: "ななし" } };

beforeEach(() => {
  items = new Map([["poke-account-secret", "覚えていたシークレット"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** `/api/account/me` には `me` を返し、`/api/account` にはプレイヤーを作った答えを返す。 */
function answer(me: Response) {
  const fetch = vi.fn<(url: string) => Promise<Response>>(async (url) =>
    url === "/api/account/me" ? me : Response.json(created),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("loadAccount", () => {
  it("サーバがそのプレイヤーはいないと言ったら、作り直す", async () => {
    answer(Response.json({ error: "いない", code: "account-not-found" }, { status: 404 }));
    await loadAccount("ななし");
    expect(items.get("poke-account-secret")).toBe("新しいシークレット");
  });

  it("合図の無い 404 では、シークレットを消さずに投げる", async () => {
    const fetch = answer(new Response("Not Found", { status: 404 }));
    await expect(loadAccount("ななし")).rejects.toThrow("シークレットはそのまま残してある");
    expect(items.get("poke-account-secret")).toBe("覚えていたシークレット");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
