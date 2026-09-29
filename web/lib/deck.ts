/**
 * 組んだデッキ。検索して足す規則、公式のデッキコードの読み方、ブラウザへの残し方。
 *
 * 枚数の上限は画面にも持つが、決めるのはサーバの検査である（仕様 5.1 節）。画面の上限は押せるボタンを絞るだけ。
 */

import type { CardChoice } from "../../src/card-index.js";
import type { DeckList } from "../../src/engine.js";
import type { OfficialCard, OfficialFailure } from "../../src/official-deck.js";
import type { CardTable } from "./cards.js";

export type { CardChoice, OfficialFailure };

export interface DeckEntry {
  defId: string;
  count: number;
}

/** 組んだデッキを置く localStorage のキー。作り直す前の画面と同じキーにして、組んだデッキをそのまま使う。 */
const DECK_KEY = "poke-deck";
/** `src/deck.ts` の値を import すると、エンジンのカード定義まで画面に入る。 */
export const DECK_SIZE = 60;
const SAME_NAME_LIMIT = 4;
const ACE_SPEC_LIMIT = 1;

const OFFICIAL_DECK_PAGE = "https://www.pokemon-card.com/deck/confirm.html/deckID/";

/**
 * 残せなかったデッキ。localStorage が使えなくても組むことはできる。投げると、画面と送る中身が食い違う。
 * `undefined` なら localStorage にあるものがいまのデッキである。
 */
let unsaved: string | null | undefined;
const listeners = new Set<() => void>();

export function storedDeckJson(): string | null {
  if (unsaved !== undefined) return unsaved;
  try {
    return localStorage.getItem(DECK_KEY);
  } catch {
    return null;
  }
}

/** 組んだデッキ。読めない値や壊れた行は捨てる。 */
export function storedDeck(): DeckEntry[] {
  return parseDeck(storedDeckJson());
}

export function parseDeck(json: string | null): DeckEntry[] {
  let saved: unknown = null;
  try {
    saved = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (entry: Partial<DeckEntry> | null): entry is DeckEntry =>
        typeof entry?.defId === "string" && Number.isInteger(entry.count) && (entry.count ?? 0) > 0,
    )
    .map((entry) => ({ defId: entry.defId, count: Math.min(entry.count, DECK_SIZE) }));
}

export function saveDeck(entries: readonly DeckEntry[]): void {
  const json = entries.length === 0 ? null : JSON.stringify(entries);
  try {
    if (json === null) localStorage.removeItem(DECK_KEY);
    else localStorage.setItem(DECK_KEY, json);
    unsaved = undefined;
  } catch {
    unsaved = json;
  }
  for (const listener of listeners) listener();
}

/** このタブで組み替えたときと、別のタブが組み替えたときに呼ぶ。`storage` は書いたタブには届かない。 */
export function subscribeDeck(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DECK_KEY || event.key === null) onChange();
  };
  listeners.add(onChange);
  addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    removeEventListener("storage", onStorage);
  };
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
