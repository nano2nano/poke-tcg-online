/**
 * 対戦に入る。デッキを出して相手をさがすか、AI との対戦を頼み、席が決まったら座席を返す。
 */

import type { BotEntry, DeckPreset } from "../../src/bots.js";
import type { DeckList } from "../../src/engine.js";
import type { ClaimOutcome, JoinOutcome, Seated } from "../../src/lobby.js";
import { getJson, postJson } from "./api.js";
import { sha256Hex, storedSeat, toHex, type StoredSeat } from "./seat.js";

export type { BotEntry, DeckList, DeckPreset };

export interface DeckEntry {
  defId: string;
  count: number;
}

/** 組んだデッキを置く localStorage のキー。いまの画面と同じキーにして、組んだデッキをそのまま使う。 */
const DECK_KEY = "poke-deck";
/** `src/deck.ts` の値を import すると、エンジンのカード定義まで画面に入る。 */
const DECK_SIZE = 60;

export function storedDeckJson(): string | null {
  return localStorage.getItem(DECK_KEY);
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

/** 組んだデッキ。組んでいなければサンプルデッキ。規則には照らさない。 */
export async function builtDeck(): Promise<{ deck: DeckList; sample: boolean }> {
  const entries = storedDeck();
  if (entries.length === 0) {
    return { deck: await getJson<DeckList>("/api/sample-deck"), sample: true };
  }
  return {
    deck: { cards: entries.flatMap(({ defId, count }) => Array<string>(count).fill(defId)) },
    sample: false,
  };
}

/** 出すデッキ。規則に通らなければ、その理由を返す。 */
export async function deckToSubmit(): Promise<
  { ok: true; deck: DeckList; sample: boolean } | { ok: false; errors: string[] }
> {
  const { deck, sample } = await builtDeck();
  if (sample) return { ok: true, deck, sample };
  const outcome = await postJson<{ ok: boolean; errors?: string[] }>("/api/deck/validate", deck);
  if (outcome.ok) return { ok: true, deck, sample };
  return { ok: false, errors: outcome.errors ?? ["デッキが通りませんでした。"] };
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
export function shareFor(seated: Seated, earlier: SeedShare | null): string | undefined {
  const stored = storedSeat();
  if (stored?.seatToken === seated.seatToken && typeof stored.seedShare === "string") {
    return stored.seedShare;
  }
  const commit = seated.seedShareCommits[seated.seat];
  return earlier !== null && earlier.commit === commit ? earlier.share : undefined;
}

export function withShare(seated: Seated, share: string | undefined): StoredSeat {
  return share === undefined ? seated : { ...seated, seedShare: share };
}

export type { ClaimOutcome, JoinOutcome, Seated };

export interface BotList {
  bots: BotEntry[];
  decks: DeckPreset[];
}

/** サーバが答えたのに読めなかった。入れ替えのあとの古いタブが、新しいサーバに尋ねたときに起きる。 */
export interface Unreadable {
  kind: "unreadable";
}

/**
 * 席を取りに行く。届かなかったときと、サーバが一時的な失敗を返したときは null で、取り直せばよい。
 * それ以外で読めない答えは `unreadable` にする。取り直しても同じ答えが返るので、待つのをやめる。
 */
export async function claim(ticket: string): Promise<ClaimOutcome | Unreadable | null> {
  let response: Response;
  try {
    response = await fetch(`/api/claim?ticket=${encodeURIComponent(ticket)}`);
  } catch {
    return null;
  }
  // 混んでいる、間に合わなかった、という答えは、取り直せば通る。
  if (response.status >= 500 || response.status === 408 || response.status === 429) return null;
  const answer = response.ok
    ? ((await response.json().catch(() => null)) as ClaimOutcome | null)
    : null;
  return answer ?? { kind: "unreadable" };
}
