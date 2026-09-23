/**
 * 公式のカード画像へ転送する。詳細ページから画像のパスを引く理由は `docs/spec/battle-server.md` 3.7 節。
 */

export const OFFICIAL_SITE = "https://www.pokemon-card.com";

/** カードデータにある cardID（`tools/build-worker.ts` が埋め込む）。 */
declare const __CARD_IDS__: string[];

let knownIds: Set<string> | null = null;

/** カードの表にある cardID か。表に無いものは公式へ読みに行かない（3.7 節）。 */
function isKnownCardId(cardID: string): boolean {
  knownIds ??= new Set(__CARD_IDS__);
  return knownIds.has(cardID);
}

/**
 * 詳細ページにある大きい画像のパス。`Location` へそのまま載せるので、URL に書ける文字だけに絞る。
 * ファイル名の頭の番号を取り出し、頼まれた cardID の画像かを確かめるのに使う。
 */
const IMAGE_PATH =
  /\/assets\/images\/card_images\/large\/[A-Za-z0-9-]*\/([0-9]+)_[A-Z]_[A-Za-z0-9_-]+\.(?:jpg|png|gif)/g;

/**
 * 引けたパスを覚える。同じカードを同時に頼まれても、公式へ読みに行くのは 1 度にする。
 * 覚えるのはこの isolate のメモリだけで、入れ替われば読み直す。
 */
const lookups = new Map<string, Promise<string | null>>();

export type PageFetcher = (url: string) => Promise<Response>;

export interface CardImageOptions {
  fetcher?: PageFetcher;
  isKnown?: (cardID: string) => boolean;
}

const fetchPage: PageFetcher = (url) =>
  fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });

/**
 * `/api/config` と `/api/card-image/<cardID>` に答える。どちらでもなければ null。
 * `enabled` が false なら転送しない。出すかどうかを切り替えられるようにしている理由は 3.7 節。
 */
export async function cardImageRoute(
  request: Request,
  enabled: boolean,
  { fetcher = fetchPage, isKnown = isKnownCardId }: CardImageOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/config") {
    return json(200, { cardImages: enabled });
  }
  const prefix = "/api/card-image/";
  if (request.method !== "GET" || !pathname.startsWith(prefix)) return null;
  if (!enabled) return json(404, { code: "card-images-off", error: "カードの画像は出していない" });
  const cardID = pathname.slice(prefix.length);
  if (!isKnown(cardID)) return json(404, { error: "カードの表に無い cardID" });

  let path: string | null;
  try {
    path = await lookup(cardID, fetcher);
  } catch (error) {
    console.warn(`カード ${cardID} の画像の場所を引けなかった:`, error);
    return json(502, { error: "公式のサイトから画像の場所を引けなかった" }, "no-store");
  }
  if (path === null) {
    // 公式のページが一時的に違う形で返ったこともありうるので、長くは覚えさせない。
    return json(404, { code: "card-image-not-found", error: "画像が見つからない" }, "max-age=600");
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
  const pending = readImagePath(cardID, fetcher);
  lookups.set(cardID, pending);
  // 覚えるのは引けたものだけにする。読めなかったものや画像の見つからなかったものを覚えると、
  // 公式が戻っても isolate が入れ替わるまで出ない。
  pending.then(
    (path) => {
      if (path === null) forget(cardID, pending);
    },
    () => forget(cardID, pending),
  );
  return pending;
}

function forget(cardID: string, pending: Promise<string | null>): void {
  if (lookups.get(cardID) === pending) lookups.delete(cardID);
}

async function readImagePath(cardID: string, fetcher: PageFetcher): Promise<string | null> {
  const response = await fetcher(
    `${OFFICIAL_SITE}/card-search/details.php/card/${cardID}/regu/all`,
  );
  if (!response.ok) {
    // 読まない本文は、読まないと明示して閉じる。
    await response.body?.cancel();
    // 無い cardID は検索の画面へ転送される。辿ると、画像の無いページを読むことになる。
    if (response.status >= 300 && response.status < 400) return null;
    throw new Error(`詳細ページが ${response.status} を返した`);
  }
  const page = await response.text();
  // ページにはほかのカードの画像も載りうる。ファイル名の番号が頼まれた cardID と合うものを採る。
  for (const found of page.matchAll(IMAGE_PATH)) {
    if (Number(found[1]) === Number(cardID)) return found[0];
  }
  return null;
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
