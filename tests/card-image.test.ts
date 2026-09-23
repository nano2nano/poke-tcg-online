/** 公式のカード画像への転送（`docs/spec/battle-server.md` 3.7 節）。 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cardImageRoute, forgetCardImages, OFFICIAL_SITE } from "../src/card-image.js";
import { startWorker, type TestWorker } from "./worker.js";

const IMAGE = "/assets/images/card_images/large/SV9a/047386_P_MYANMAEX.jpg";

/** 公式の詳細ページの代わり。読まれた URL を数える。 */
function officialSite(pages: Record<string, Response | (() => Response)>) {
  const asked: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    asked.push(url);
    const page = pages[url];
    if (page === undefined) throw new Error(`用意していない URL: ${url}`);
    return typeof page === "function" ? page() : page.clone();
  };
  return { asked, fetcher };
}

const detail = (cardID: string) =>
  `${OFFICIAL_SITE}/card-search/details.php/card/${cardID}/regu/all`;
const page = (body: string) => new Response(body, { status: 200 });
const get = (path: string) => new Request(`http://server${path}`);

beforeEach(() => forgetCardImages());

describe("公式のカード画像への転送", () => {
  it("詳細ページから画像のパスを引き、公式の画像へ転送する", async () => {
    const { fetcher } = officialSite({
      [detail("47386")]: page(`<img class="fit" src="${IMAGE}" alt="ミャンマーex">`),
    });
    const response = await cardImageRoute(get("/api/card-image/47386"), true, fetcher);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(`${OFFICIAL_SITE}${IMAGE}`);
  });

  it("同じカードは、同時に頼まれても公式を 1 度しか読まない", async () => {
    const { asked, fetcher } = officialSite({ [detail("47386")]: page(`src="${IMAGE}"`) });
    const responses = await Promise.all(
      [0, 1, 2].map(() => cardImageRoute(get("/api/card-image/47386"), true, fetcher)),
    );
    expect(responses.map((response) => response?.status)).toEqual([302, 302, 302]);
    expect(asked).toHaveLength(1);
  });

  // ページの中に別のカードの画像があっても、それを頼まれたカードの画像として出さない。
  it("ファイル名の番号が頼まれた cardID と違えば、見つからないと答える", async () => {
    const { fetcher } = officialSite({ [detail("47000")]: page(`src="${IMAGE}"`) });
    const response = await cardImageRoute(get("/api/card-image/47000"), true, fetcher);
    expect(response?.status).toBe(404);
    expect(await response?.json()).toMatchObject({ code: "card-image-not-found" });
  });

  it("無い cardID で転送されたら、辿らずに見つからないと答える", async () => {
    const { fetcher } = officialSite({
      [detail("99999999")]: new Response(null, {
        status: 302,
        headers: { location: `${OFFICIAL_SITE}/card-search/` },
      }),
    });
    const response = await cardImageRoute(get("/api/card-image/99999999"), true, fetcher);
    expect(response?.status).toBe(404);
  });

  it("公式を読めなかったときは覚えず、次に頼まれたら読み直す", async () => {
    let down = true;
    const { asked, fetcher } = officialSite({
      [detail("47386")]: () => (down ? new Response("", { status: 503 }) : page(`src="${IMAGE}"`)),
    });
    const first = await cardImageRoute(get("/api/card-image/47386"), true, fetcher);
    expect(first?.status).toBe(502);
    expect(first?.headers.get("cache-control")).toBe("no-store");
    down = false;
    const second = await cardImageRoute(get("/api/card-image/47386"), true, fetcher);
    expect(second?.status).toBe(302);
    expect(asked).toHaveLength(2);
  });

  it("数字でない cardID では公式を読みに行かない", async () => {
    const { asked, fetcher } = officialSite({});
    for (const cardID of ["abc", "1%2F2", "12a", ""]) {
      const response = await cardImageRoute(get(`/api/card-image/${cardID}`), true, fetcher);
      expect(response?.status).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it("切ってあるときは公式を読まず、画面にも出さないと伝える", async () => {
    const { asked, fetcher } = officialSite({});
    const image = await cardImageRoute(get("/api/card-image/47386"), false, fetcher);
    expect(image?.status).toBe(404);
    expect(await image?.json()).toMatchObject({ code: "card-images-off" });
    const config = await cardImageRoute(get("/api/config"), false, fetcher);
    expect(await config?.json()).toEqual({ cardImages: false });
    expect(asked).toEqual([]);
  });

  it("ほかのパスには答えない", async () => {
    const { fetcher } = officialSite({});
    expect(await cardImageRoute(get("/api/cards"), true, fetcher)).toBeNull();
  });
});

describe("Worker の配線", () => {
  let off: TestWorker;
  let on: TestWorker;

  beforeAll(async () => {
    [off, on] = await Promise.all([startWorker({ CARD_IMAGES: "off" }), startWorker()]);
  });

  afterAll(async () => {
    await Promise.all([off.close(), on.close()]);
  });

  it("`CARD_IMAGES` を `official` 以外にすると切れる", async () => {
    const response = await fetch(`http://${off.host}/api/config`);
    expect(await response.json()).toEqual({ cardImages: false });
  });

  it("`wrangler.jsonc` の設定では出す", async () => {
    const config = await fetch(`http://${on.host}/api/config`);
    expect(await config.json()).toEqual({ cardImages: true });
    // 公式へは読みに行かせずに、転送の入口まで届いていることだけを見る。
    const refused = await fetch(`http://${on.host}/api/card-image/abc`, { redirect: "manual" });
    expect(refused.status).toBe(400);
  });

  it("カードの表に、画像を頼むための cardID が載る", async () => {
    const cards = (await (await fetch(`http://${off.host}/api/cards`)).json()) as Record<
      string,
      { cardID?: string }
    >;
    const values = Object.values(cards);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((card) => /^[0-9]+$/.test(card.cardID ?? ""))).toBe(true);
  });
});
