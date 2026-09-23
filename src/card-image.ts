/**
 * 公式のカード画像へ転送する（`docs/spec/battle-server.md` 3.7 節）。
 *
 * 画像のファイル名にはセット記号とカード名のローマ字が入り、cardID だけでは組み立てられない。
 * エンジンのカードデータもローマ字を持たないので、公式のカード詳細ページを 1 度読んで引く。
 * 画像そのものは中継も保存もしない。ブラウザは公式から直接読む。
 */

export const OFFICIAL_SITE = "https://www.pokemon-card.com";

/** 詳細ページの URL にそのまま載せるので、数字のほかは通さない。 */
const CARD_ID = /^[0-9]{1,8}$/;

/**
 * 詳細ページにある大きい画像のパス。`Location` へそのまま載せるので、URL に書ける文字だけに絞る。
 * ファイル名の頭の番号を取り出し、頼まれた cardID のページかを確かめるのに使う。
 */
const IMAGE_PATH =
  /\/assets\/images\/card_images\/large\/[A-Za-z0-9-]*\/([0-9]+)_[A-Z]_[A-Za-z0-9_-]+\.(?:jpg|png|gif)/;

/** 覚えておく cardID の数の上限。どの cardID でも頼めるので、上限が無いとメモリが伸び続ける。 */
const REMEMBERED = 10_000;

/**
 * 引いた結果を覚える。同じカードを同時に頼まれても、公式へ読みに行くのは 1 度にする。
 * 覚えるのはこの isolate のメモリだけで、入れ替われば読み直す。
 */
const lookups = new Map<string, Promise<string | null>>();

export type PageFetcher = (url: string) => Promise<Response>;

const fetchPage: PageFetcher = (url) =>
  fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });

/**
 * `/api/config` と `/api/card-image/<cardID>` に答える。どちらでもなければ null。
 *
 * 公式のサイトは、掲載物の利用を個人で楽しむ範囲に限っている。公開するサイトで出すかは
 * 運営する人が決めることなので、`enabled` が false なら転送しない。
 */
export async function cardImageRoute(
  request: Request,
  enabled: boolean,
  fetcher: PageFetcher = fetchPage,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/config") {
    return json(200, { cardImages: enabled });
  }
  const prefix = "/api/card-image/";
  if (request.method !== "GET" || !pathname.startsWith(prefix)) return null;
  if (!enabled) return json(404, { code: "card-images-off", error: "カードの画像は出していない" });
  const cardID = pathname.slice(prefix.length);
  if (!CARD_ID.test(cardID)) return json(400, { error: "cardID は数字で指定する" });

  let path: string | null;
  try {
    path = await lookup(cardID, fetcher);
  } catch (error) {
    console.warn(`カード ${cardID} の画像の場所を引けなかった:`, error);
    return json(502, { error: "公式のサイトから画像の場所を引けなかった" }, "no-store");
  }
  if (path === null) {
    return json(404, { code: "card-image-not-found", error: "画像が見つからない" }, "max-age=3600");
  }
  // 画像のパスは収録ごとに決まっていて変わらないので、ブラウザに長く覚えさせる。
  // 覚えていれば、盤面を描き直すたびにここを通らずに済む。
  return new Response(null, {
    status: 302,
    headers: { location: `${OFFICIAL_SITE}${path}`, "cache-control": "public, max-age=604800" },
  });
}

function lookup(cardID: string, fetcher: PageFetcher): Promise<string | null> {
  const known = lookups.get(cardID);
  if (known !== undefined) return known;
  if (lookups.size >= REMEMBERED) lookups.clear();
  const pending = readImagePath(cardID, fetcher);
  lookups.set(cardID, pending);
  // 読みに行けなかっただけのものは覚えない。覚えると、公式が戻っても isolate が入れ替わるまで出ない。
  pending.catch(() => {
    if (lookups.get(cardID) === pending) lookups.delete(cardID);
  });
  return pending;
}

async function readImagePath(cardID: string, fetcher: PageFetcher): Promise<string | null> {
  const response = await fetcher(
    `${OFFICIAL_SITE}/card-search/details.php/card/${cardID}/regu/all`,
  );
  // 無い cardID は検索の画面へ転送される。辿ると、画像の無いページを読むことになる。
  if (response.status >= 300 && response.status < 400) return null;
  if (!response.ok) throw new Error(`詳細ページが ${response.status} を返した`);
  const found = IMAGE_PATH.exec(await response.text());
  // 別のカードの画像を出さないよう、ファイル名の番号まで突き合わせる。
  if (found === null || Number(found[1]) !== Number(cardID)) return null;
  return found[0];
}

function json(status: number, body: unknown, cacheControl?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (cacheControl !== undefined) headers["cache-control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/** テストが、覚えた結果を捨ててから次を確かめるのに使う。 */
export function forgetCardImages(): void {
  lookups.clear();
}
