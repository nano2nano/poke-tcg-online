/**
 * 保存したデッキ（仕様 5.5 節）。検索して足す規則と、公式のデッキコードの読み方。
 *
 * 枚数の上限は画面にも持つが、決めるのはサーバの検査である（仕様 5.1 節）。画面の上限は押せるボタンを絞るだけ。
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { CardChoice } from "../../src/card-index.js";
import type { DeckEntry } from "../../src/deck.js";
import type { SavedDeck } from "../../src/decks.js";
import type { DeckList } from "../../src/engine.js";
import type { OfficialCard, OfficialFailure } from "../../src/official-deck.js";
import { accountQuery, postAsPlayer } from "./account.js";
import type { CardTable } from "./cards.js";

export type { CardChoice, DeckEntry, OfficialFailure, SavedDeck };

/** `src/deck.ts` の値を import すると、エンジンのカード定義まで画面に入る。 */
export const DECK_SIZE = 60;
const SAME_NAME_LIMIT = 4;
const ACE_SPEC_LIMIT = 1;

const OFFICIAL_DECK_PAGE = "https://www.pokemon-card.com/deck/confirm.html/deckID/";

/**
 * 保存したデッキの一覧。プレイヤーを用意できてから頼む。プレイヤーが替わったら、前のプレイヤーの一覧を出さない。
 * `failure` は、プレイヤーを用意できなかったか一覧を読めなかった理由。どちらでも一覧は届かない。
 */
export function useSavedDecks() {
  const queryClient = useQueryClient();
  const account = useQuery(accountQuery());
  const playerId = account.data?.playerId ?? null;
  const decks = useQuery({
    queryKey: [...DECKS_KEY, playerId],
    queryFn: () => loadDecks(queryClient),
    enabled: playerId !== null,
  });
  const failure = decks.isError ? decks.error : account.isError ? account.error : null;
  return { decks, failure };
}

const DECKS_KEY = ["decks"] as const;

async function loadDecks(queryClient: QueryClient): Promise<SavedDeck[]> {
  await moveBrowserDeck(queryClient);
  const { decks } = await postAsPlayer<{ decks: SavedDeck[] }>(queryClient, "/api/decks", {});
  return decks;
}

/**
 * 前の版は、組んだデッキをこのブラウザの localStorage に 1 つだけ残していた。保存したデッキへ移してから消す。
 * 消さずに移すと、開くたびに同じデッキが増える。移せなかったら残しておき、次に開いたときにまた移す。
 * 移せないことで一覧まで出せなくはしない。
 */
async function moveBrowserDeck(queryClient: QueryClient): Promise<void> {
  const key = "poke-deck";
  try {
    const cards = parseBrowserDeck(localStorage.getItem(key));
    if (cards.length === 0) return;
    await postAsPlayer(queryClient, "/api/decks/save", {
      name: "このブラウザで組んだデッキ",
      cards,
    });
    localStorage.removeItem(key);
  } catch {
    // 一覧を読む要求が、プレイヤーが忘れられていたことなどを同じように知らせる。
  }
}

/** 読めない行は捨て、サーバが受ける形（同じカードは 1 行、合わせて 60 枚まで）にそろえる。 */
export function parseBrowserDeck(json: string | null): DeckEntry[] {
  let saved: unknown = null;
  try {
    saved = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  let entries: DeckEntry[] = [];
  for (const entry of saved as (Partial<DeckEntry> | null)[]) {
    if (typeof entry?.defId !== "string" || !Number.isInteger(entry.count)) continue;
    const room = DECK_SIZE - deckSize(entries);
    const count = Math.min(entry.count ?? 0, room);
    if (count > 0) entries = withCount(entries, entry.defId, count);
  }
  return entries;
}

/**
 * 保存する。`deckId` が無ければ新しいデッキになる。一覧は取り直す。
 * 新しいデッキのページを初めて開いたブラウザは、まだプレイヤーを持たないので、ここで用意する。
 */
export async function saveDeck(
  queryClient: QueryClient,
  deck: { deckId?: string; name: string; cards: readonly DeckEntry[] },
): Promise<SavedDeck> {
  await queryClient.fetchQuery(accountQuery());
  const { deck: saved } = await postAsPlayer<{ deck: SavedDeck }>(
    queryClient,
    "/api/decks/save",
    deck,
  );
  await queryClient.invalidateQueries({ queryKey: DECKS_KEY });
  return saved;
}

export async function deleteDeck(queryClient: QueryClient, deckId: string): Promise<void> {
  await postAsPlayer(queryClient, "/api/decks/delete", { deckId });
  await queryClient.invalidateQueries({ queryKey: DECKS_KEY });
}

export function deckCards(entries: readonly DeckEntry[]): DeckList {
  return { cards: entries.flatMap(({ defId, count }) => Array<string>(count).fill(defId)) };
}

export function deckSize(entries: readonly DeckEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

export function withCount(
  entries: readonly DeckEntry[],
  defId: string,
  delta: number,
): DeckEntry[] {
  const next = entries
    .map((entry) => (entry.defId === defId ? { defId, count: entry.count + delta } : entry))
    .filter((entry) => entry.count > 0);
  if (delta > 0 && !entries.some((entry) => entry.defId === defId)) {
    next.push({ defId, count: delta });
  }
  return next;
}

export function canAdd(entries: readonly DeckEntry[], table: CardTable, defId: string): boolean {
  const card = table[defId];
  if (card === undefined) return false;
  let total = 0;
  let sameName = 0;
  let aceSpecs = 0;
  for (const entry of entries) {
    total += entry.count;
    if (table[entry.defId]?.name === card.name) sameName += entry.count;
    if (table[entry.defId]?.aceSpec === true) aceSpecs += entry.count;
  }
  return (
    total < DECK_SIZE &&
    (card.basicEnergy === true || sameName < SAME_NAME_LIMIT) &&
    (card.aceSpec !== true || aceSpecs < ACE_SPEC_LIMIT)
  );
}

export interface SearchRow {
  defId: string;
  name: string;
  text: string;
}

/** 検索で比べる形と名前の順。表が届いたときに 1 度だけ作る。打つたび、押すたびに全部を作り直さない。 */
export function searchRows(table: CardTable): SearchRow[] {
  const collator = new Intl.Collator("ja");
  const entries = Object.entries(table);
  entries.sort(
    ([a, first], [b, second]) => collator.compare(first.name, second.name) || (a < b ? -1 : 1),
  );
  return entries.map(([defId, card]) => ({
    defId,
    name: searchKey(card.name),
    text: searchKey(
      [card.name, ...(card.attacks ?? []), ...(card.abilities ?? []), card.set, card.number].join(
        " ",
      ),
    ),
  }));
}

/**
 * 打った語をすべて含むカード。名前の前方一致を先に並べる。
 *
 * 名前だけでは絞れない。同じ名前のカードが表示の上限より多いこともあるので、ワザや特性の名前、
 * 収録でも当たるようにして、空白で区切って打ち足せるようにする。
 */
export function searchCards(rows: readonly SearchRow[], query: string): SearchRow[] {
  const words = searchWords(query);
  const [first] = words;
  if (first === undefined) return [];
  const matched = rows.filter(({ text }) => words.every((word) => text.includes(word)));
  return [
    ...matched.filter(({ name }) => name.startsWith(first)),
    ...matched.filter(({ name }) => !name.startsWith(first)),
  ];
}

export function searchWords(query: string): string[] {
  return searchKey(query).split(/\s+/).filter(Boolean);
}

/** ひらがなで打ってもカタカナの名前に当たるようにし、全角と半角の違いも潰す。 */
function searchKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

/** 入れた文字からデッキコードを取り出す。デッキのページの URL を貼られても読む。 */
export function deckCodeOf(text: string): string | null {
  const trimmed = text.trim();
  const code = /deckID[/=]([0-9A-Za-z-]+)/.exec(trimmed)?.[1] ?? trimmed;
  return /^[0-9A-Za-z]+(-[0-9A-Za-z]+)*$/.test(code) ? code : null;
}

export interface OfficialDeck {
  cards: OfficialCard[];
  /** カード ID から、公式のページにある名前。このサーバに無いカードを名前で出すのに使う。 */
  names: Record<string, string>;
}

/** 公式のデッキ確認ページを読む。デッキが無ければ null。 */
export async function fetchOfficialDeck(code: string): Promise<OfficialDeck | null> {
  let response: Response;
  try {
    response = await fetch(`${OFFICIAL_DECK_PAGE}${encodeURIComponent(code)}/`, {
      credentials: "omit",
    });
  } catch {
    throw new Error("公式サイトに繋がりませんでした");
  }
  if (!response.ok) throw new Error(`公式サイトが ${response.status} を返しました`);
  const html = await response.text();
  const fields = [
    ...new DOMParser()
      .parseFromString(html, "text/html")
      .querySelectorAll<HTMLInputElement>('input[id^="deck_"]'),
  ].map((field) => field.value);
  return readOfficialPage(fields, html);
}

/**
 * 公式のデッキ確認ページの中身を読む。
 *
 * 枚数は `deck_*` の hidden input に「カード ID_枚数_…」を `-` でつないだ形で入っている。
 * 見つからないコードでも input は空で並ぶので、1 つも無ければページの形が変わったと読む。
 */
export function readOfficialPage(fields: readonly string[], html: string): OfficialDeck | null {
  if (fields.length === 0) throw new Error("公式サイトのページの形が変わっています");
  const cards: OfficialCard[] = [];
  for (const field of fields) {
    for (const item of field.split("-").filter(Boolean)) {
      const match = /^([0-9]+)_([0-9]+)(_|$)/.exec(item);
      if (match === null) throw new Error("公式サイトのページの形が変わっています");
      cards.push({ cardId: match[1] as string, count: Number(match[2]) });
    }
  }
  if (cards.length === 0) return null;

  // 名前はページのスクリプトの中にある。DOMParser はスクリプトを動かさないので、文字列として読む。
  const names: Record<string, string> = {};
  for (const [, cardId, quoted] of html.matchAll(
    /searchItemName\[([0-9]+)\]\s*=\s*'((?:[^'\\]|\\.)*)'/g,
  )) {
    names[cardId as string] = (quoted as string).replace(/\\(.)/g, "$1");
  }
  return { cards, names };
}
