/** プレイヤーが保存したデッキ（`docs/spec/battle-server.md` 5.5 節）。 */

import { randomBytes } from "node:crypto";
import type { D1Database } from "@cloudflare/workers-types/index.ts";
import { deckFromEntries, describeViolation, validateDeck, type DeckEntry } from "./deck.js";
import { cleanText } from "./text.js";

/** 1 人が保存できるデッキの数。消すエンドポイントがあるので、溢れたら人が選んで消せる。 */
export const DECK_LIMIT = 50;

/** デッキの名前の上限。表示名と同じく、長さと見えない字だけ見る。 */
const MAX_DECK_NAME = 40;

const DEFAULT_DECK_NAME = "名前のないデッキ";

/** 保存できる数を越えたことの合図。 */
export const TOO_MANY_DECKS = "too-many-decks";

/** 自分のデッキに無いことの合図。別のブラウザで消したデッキを置き換えようとしたときに返る。 */
export const DECK_NOT_FOUND = "deck-not-found";

export interface SavedDeck {
  deckId: string;
  name: string;
  cards: DeckEntry[];
  updatedAt: string;
  /** いまのカードデータで照らした 5.1 節の検査の結果。空なら対戦に出せる。 */
  errors: string[];
}

interface DeckRow {
  deck_id: string;
  name: string;
  cards: string;
  updated_at: string;
}

export type SaveOutcome =
  | { kind: "saved"; deck: SavedDeck }
  | { kind: "not-found" }
  | { kind: "full" };

export class DeckStore {
  constructor(private readonly db: D1Database) {}

  async list(playerId: string): Promise<SavedDeck[]> {
    const { results } = await this.db
      .prepare(
        "SELECT deck_id, name, cards, updated_at FROM decks WHERE player_id = ? ORDER BY updated_at DESC, deck_id",
      )
      .bind(playerId)
      .all<DeckRow>();
    return results.map(deckOf);
  }

  /**
   * `deckId` が無ければ新しく保存し、あれば置き換える。置き換えられるのは自分のデッキだけで、
   * ほかの人のデッキと、無いデッキは同じ `not-found` にする。
   */
  async save(
    playerId: string,
    deck: { deckId?: string; name: string; cards: DeckEntry[] },
    nowMs: number,
  ): Promise<SaveOutcome> {
    const name = cleanText(deck.name, MAX_DECK_NAME) || DEFAULT_DECK_NAME;
    const cards = JSON.stringify(deck.cards);
    const at = new Date(nowMs).toISOString();
    if (deck.deckId !== undefined) {
      const { meta } = await this.db
        .prepare(
          "UPDATE decks SET name = ?, cards = ?, updated_at = ? WHERE deck_id = ? AND player_id = ?",
        )
        .bind(name, cards, at, deck.deckId, playerId)
        .run();
      if (meta.changes === 0) return { kind: "not-found" };
      return { kind: "saved", deck: deckOf({ deck_id: deck.deckId, name, cards, updated_at: at }) };
    }
    const deckId = randomBytes(12).toString("base64url");
    // 数えるのと足すのを 1 つの文にする。分けると、並んで届いた保存が両方とも上限の手前で数える。
    const { meta } = await this.db
      .prepare(
        `INSERT INTO decks (deck_id, player_id, name, cards, updated_at)
           SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM decks WHERE player_id = ?) < ?`,
      )
      .bind(deckId, playerId, name, cards, at, playerId, DECK_LIMIT)
      .run();
    if (meta.changes === 0) return { kind: "full" };
    return { kind: "saved", deck: deckOf({ deck_id: deckId, name, cards, updated_at: at }) };
  }

  /** 消したら true。自分のデッキでなければ false。 */
  async remove(playerId: string, deckId: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare("DELETE FROM decks WHERE deck_id = ? AND player_id = ?")
      .bind(deckId, playerId)
      .run();
    return meta.changes > 0;
  }
}

function deckOf(row: DeckRow): SavedDeck {
  const cards = JSON.parse(row.cards) as DeckEntry[];
  return {
    deckId: row.deck_id,
    name: row.name,
    cards,
    updatedAt: row.updated_at,
    errors: validateDeck(deckFromEntries(cards)).map(describeViolation),
  };
}
