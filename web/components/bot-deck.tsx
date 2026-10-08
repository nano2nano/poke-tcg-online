import { Link } from "@tanstack/react-router";
import type { SavedDeck } from "../lib/deck.js";
import type { DeckPreset } from "../lib/join.js";

/**
 * AI に握らせるデッキの選択肢（仕様 7.3 節）。学習で握った表のデッキを先に、保存したデッキとサンプルデッキを
 * 「学習していないデッキ」として分けて出す。AI と対戦する欄と、AI どうしの対戦を立てる欄が使う。
 */
export function BotDeckOptions({
  presets,
  saved,
  presetName,
}: {
  presets: readonly DeckPreset[];
  saved: readonly SavedDeck[];
  presetName: (deck: DeckPreset) => string;
}) {
  return (
    <>
      {presets.length > 0 && (
        <optgroup label="AI が学習したデッキ">
          {presets.map((deck) => (
            <option key={deck.label} value={`preset:${deck.label}`}>
              {presetName(deck)}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="AI が学習していないデッキ">
        {saved.map((deck) => (
          <option key={deck.deckId} value={`saved:${deck.deckId}`}>
            {savedDeckLabel(deck)}
          </option>
        ))}
        <option value="sample">サンプルデッキ</option>
      </optgroup>
    </>
  );
}

/** AI が学習で握っていないデッキを選んだときの一言。規則を通らない保存したデッキなら、そう出す。 */
export function UntrainedDeckNote({ deck }: { deck: SavedDeck | null }) {
  return deck !== null && deck.errors.length > 0 ? (
    <UnplayableNote deck={deck} />
  ) : (
    "AI はこのデッキの回し方を学習していません。"
  );
}

export function UnplayableNote({ deck }: { deck: SavedDeck }) {
  return (
    <>
      このデッキは規則を通りません（{deck.errors.join("、")}）。{" "}
      <Link to="/decks/$deckId" params={{ deckId: deck.deckId }}>
        デッキを直す
      </Link>
    </>
  );
}

export function savedDeckLabel(deck: SavedDeck): string {
  return deck.errors.length === 0 ? deck.name : `${deck.name}（規則を通りません）`;
}
