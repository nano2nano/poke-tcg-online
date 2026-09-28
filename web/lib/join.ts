/**
 * 対戦に入る。デッキを出して相手をさがすか、AI との対戦を頼み、席が決まったら座席を返す。
 */

import type { BotEntry, DeckPreset } from "../../src/bots.js";
import type { DeckList } from "../../src/engine.js";
import type { ClaimOutcome, JoinOutcome, Seated } from "../../src/lobby.js";
import { getJson } from "./api.js";
import { deckCards, storedDeck } from "./deck.js";
import { sha256Hex, storedSeat, toHex, type StoredSeat } from "./seat.js";

export type { BotEntry, DeckList, DeckPreset };

/** 組んだデッキ。組んでいなければサンプルデッキ。規則には照らさない。 */
export async function builtDeck(): Promise<{ deck: DeckList; sample: boolean }> {
  const entries = storedDeck();
  if (entries.length === 0) {
    return { deck: await getJson<DeckList>("/api/sample-deck"), sample: true };
  }
  return { deck: deckCards(entries), sample: false };
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
