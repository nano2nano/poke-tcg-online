import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { messageOf } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import { deckSize, deleteDeck, useSavedDecks, type SavedDeck } from "../lib/deck.js";
import { rememberDeckChoice } from "../lib/join.js";
import { CardFace } from "./board.js";

/** 保存したデッキの一覧。開いて組み直すか、対戦に使うデッキに選ぶか、消す。 */
export function DeckList() {
  const { table } = useCardData();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { decks, failure } = useSavedDecks();
  const [status, setStatus] = useState("");

  const play = (deck: SavedDeck) => {
    rememberDeckChoice(`saved:${deck.deckId}`);
    void navigate({ to: "/" });
  };
  const remove = (deck: SavedDeck) => {
    if (!confirm(`「${deck.name}」を消しますか。`)) return;
    setStatus("");
    deleteDeck(queryClient, deck.deckId).catch((error: unknown) =>
      setStatus(`消せませんでした: ${messageOf(error)}`),
    );
  };
  /** 一覧の絵に使うカード。いちばん多く入れたポケモンにする。 */
  const cover = (deck: SavedDeck) =>
    deck.cards
      .filter(({ defId }) => table[defId]?.kind === "pokemon")
      .reduce<SavedDeck["cards"][number] | null>(
        (best, entry) => (best === null || entry.count > best.count ? entry : best),
        null,
      )?.defId;

  return (
    <section id="decks">
      <div className="page-head">
        <h1>デッキ</h1>
        <Link id="new-deck" to="/decks/new" className="button primary">
          新しいデッキを組む
        </Link>
      </div>
      <p className="note">
        カードを検索して組むか、公式のデッキコードから読み込みます。保存したデッキはプレイヤーに紐づいてサーバに残ります。
      </p>
      <p id="decks-status" className="note">
        {failure === null ? status : `デッキを読めませんでした: ${messageOf(failure)}`}
      </p>
      {decks.data?.length === 0 && <p className="note">まだ保存したデッキがありません。</p>}
      <ul id="deck-list" className="deck-list">
        {decks.data?.map((deck) => {
          const defId = cover(deck);
          const playable = deck.errors.length === 0;
          return (
            <li key={deck.deckId} className="deck-item" data-deck-id={deck.deckId}>
              <Link to="/decks/$deckId" params={{ deckId: deck.deckId }} className="deck-open">
                {defId === undefined ? (
                  <span className="card empty thumb" />
                ) : (
                  <CardFace defId={defId} thumb />
                )}
                <span>
                  <strong>{deck.name}</strong>
                  <span className={playable ? "deck-meta ok" : "deck-meta ng"}>
                    {`${deckSize(deck.cards)} 枚・${playable ? "対戦に使えます" : "規則を通りません"}`}
                  </span>
                </span>
              </Link>
              <div className="deck-item-actions">
                <button
                  type="button"
                  className="secondary play-deck"
                  disabled={!playable}
                  onClick={() => play(deck)}
                >
                  このデッキで対戦
                </button>
                <button
                  type="button"
                  className="secondary delete-deck"
                  onClick={() => remove(deck)}
                >
                  消す
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
