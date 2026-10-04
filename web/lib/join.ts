/**
 * 対戦に入る。デッキを出して相手をさがすか、AI との対戦を頼み、席が決まったら座席を返す。
 */

import type { BotEntry, DeckPreset } from "../../src/bots.js";
import type { DeckList } from "../../src/engine.js";
import type { ClaimOutcome, JoinOutcome, Seated } from "../../src/lobby.js";
import { queryOptions } from "@tanstack/react-query";
import { getJson, postJson } from "./api.js";
import type { CardTable } from "./cards.js";
import { deckCards, type SavedDeck } from "./deck.js";
import { sha256Hex, storedSeat, toHex, type StoredSeat } from "./seat.js";

export type { DeckList, DeckPreset };

/**
 * 対戦に使うデッキの選び方。保存したデッキは `saved:<deckId>`、サンプルデッキは `sample`、
 * AI と同じ表のデッキは `preset:<ラベル>`。選んだものは、次に開いたときのためにこのブラウザに残す。
 */
export type DeckChoice = `saved:${string}` | "sample" | `preset:${string}`;

const CHOICE_KEY = "poke-deck-choice";

export function storedDeckChoice(): DeckChoice | null {
  try {
    const choice = localStorage.getItem(CHOICE_KEY);
    return choice === "sample" || /^(saved|preset):./.test(choice ?? "")
      ? (choice as DeckChoice)
      : null;
  } catch {
    return null;
  }
}

export function rememberDeckChoice(choice: DeckChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, choice);
  } catch {
    // 残せなくても、この画面では選んだデッキで対戦に入れる。
  }
}

/**
 * 使うデッキ。前に選んだものが一覧に無ければ（消したデッキ、表から外れたデッキ）、規則を通る保存したデッキの先頭か、
 * AI と同じ表のデッキの先頭にする。サンプルデッキは AI が学んだことの無い相手になる。
 */
export function resolveDeckChoice(
  picked: DeckChoice | null,
  saved: readonly SavedDeck[],
  presets: readonly DeckPreset[],
): DeckChoice {
  if (picked !== null && isListed(picked, saved, presets)) return picked;
  const playable = saved.find(({ errors }) => errors.length === 0);
  if (playable !== undefined) return `saved:${playable.deckId}`;
  return firstPreset(presets);
}

/**
 * AI のデッキ。選んだものが一覧に無いか、まだ選んでいなければ、表のデッキの先頭にする。
 * 表のデッキは AI が学習で握ったデッキで、ほかのデッキの回し方を AI は学んでいない。
 */
export function resolveBotDeckChoice(
  picked: DeckChoice | null,
  saved: readonly SavedDeck[],
  presets: readonly DeckPreset[],
): DeckChoice {
  if (picked !== null && isListed(picked, saved, presets)) return picked;
  return firstPreset(presets);
}

function firstPreset(presets: readonly DeckPreset[]): DeckChoice {
  return presets[0] === undefined ? "sample" : `preset:${presets[0].label}`;
}

/** 選んだデッキが、いまの一覧にあるか。サンプルデッキはいつもある。 */
export function isListed(
  choice: DeckChoice,
  saved: readonly SavedDeck[],
  presets: readonly DeckPreset[],
): boolean {
  return (
    choice === "sample" ||
    saved.some(({ deckId }) => `saved:${deckId}` === choice) ||
    presets.some(({ label }) => `preset:${label}` === choice)
  );
}

/**
 * 送るデッキ。規則には照らさない。照らすのはサーバで、続いている対戦があればデッキより先にその席を返す。
 */
export async function deckRequest(
  choice: DeckChoice,
  saved: readonly SavedDeck[],
): Promise<{ deck: DeckList } | { deckPreset: string }> {
  if (choice === "sample") return { deck: await getJson<DeckList>("/api/sample-deck") };
  if (choice.startsWith("preset:")) return { deckPreset: choice.slice("preset:".length) };
  const deck = saved.find(({ deckId }) => `saved:${deckId}` === choice);
  if (deck === undefined) throw new Error("選んだデッキが見つかりません");
  return { deck: deckCards(deck.cards) };
}

export interface SeedShare {
  share: string;
  commit: string;
}

/**
 * シャッフルへのシェアを作る（仕様 6.4 節）。送るのはコミットだけで、値は席に着いてから開く。
 * `crypto.subtle` は https か localhost でしか使えない。無ければシェアを出さずに入る。
 */
export async function newSeedShare(): Promise<SeedShare | null> {
  if (globalThis.crypto?.subtle === undefined) return null;
  const share = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { share, commit: await sha256Hex(`share:${share}`) };
}

/**
 * 戻る席に出したシェア。覚えている席か、前に頼んだときのシェアのうち、その席のコミットに合うもの。
 * どちらにも無ければ undefined で、シェアを開かずに入る（シャッフルの検算はそのことを出す）。
 */
export function shareFor(seated: Seated, earlier: readonly SeedShare[]): string | undefined {
  const stored = storedSeat();
  if (stored?.seatToken === seated.seatToken && typeof stored.seedShare === "string") {
    return stored.seedShare;
  }
  const commit = seated.seedShareCommits[seated.seat];
  return earlier.find((share) => share.commit === commit)?.share;
}

export function withShare(seated: Seated, share: string | undefined): StoredSeat {
  return share === undefined ? seated : { ...seated, seedShare: share };
}

export type { ClaimOutcome, JoinOutcome, Seated };

/** 相手が人か AI かで分かれる。 */
const LIVE_CODES: ReadonlySet<string> = new Set(["match-live", "bot-match-live"]);

/** 続いている対戦があるので断ったときに、サーバが一緒に返したその席。 */
export function liveSeatOf(outcome: JoinOutcome): Seated | null {
  if (outcome.ok || outcome.code === undefined || !LIVE_CODES.has(outcome.code)) return null;
  return outcome.seat ?? null;
}

export interface BotList {
  bots: BotEntry[];
  decks: DeckPreset[];
}

/** AI の一覧。AI と対戦する欄と、AI どうしの対戦を立てる欄が同じ答えを使う。 */
export const botListQuery = queryOptions({
  queryKey: ["bots"],
  queryFn: () => getJson<BotList>("/api/bots"),
  staleTime: Infinity,
});

/** デッキの名前は看板のカードの名前をつなぐ。カードの表が届くまではラベルを出す（仕様 7.3 節）。 */
export function presetName(deck: DeckPreset, cards: CardTable): string {
  const names = deck.aces.map((ace) => cards[ace]?.name);
  return names.length > 0 && names.every((one) => one !== undefined)
    ? names.join("・")
    : deck.label;
}

/**
 * 相手を待つのをやめる。もう席が決まっていれば、引き換えと同じ答えが返る。
 * 届かなければ null で、チケットはキューに残っているかもしれない。
 */
export async function leaveQueue(ticket: string): Promise<ClaimOutcome | null> {
  return postJson<ClaimOutcome>("/api/leave", { ticket }).catch(() => null);
}

/** 成功を返したのに読めない答え。入れ替えのあとの古いタブが、新しいサーバに尋ねたときに起きる。 */
export interface Unreadable {
  kind: "unreadable";
}

/**
 * 席を取りに行く。届かなかったときと、サーバが失敗を返したときは null で、取り直せばよい。
 * 失敗の番号だけでは、サーバの答えか間の中継の答えか見分けられない。待つのをやめると、
 * そのあいだに決まった席に誰も座らず時間切れで負ける。
 * 成功を返したのに読めない答えは `unreadable` にする。取り直しても同じ答えが返るので、待つのをやめる。
 */
export async function claim(ticket: string): Promise<ClaimOutcome | Unreadable | null> {
  let response: Response;
  try {
    response = await fetch(`/api/claim?ticket=${encodeURIComponent(ticket)}`);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const answer = (await response.json().catch(() => null)) as ClaimOutcome | null;
  return answer ?? { kind: "unreadable" };
}
