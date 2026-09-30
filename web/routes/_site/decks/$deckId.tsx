import { createFileRoute, Link } from "@tanstack/react-router";
import { DeckBuilder } from "../../../components/deck-builder.js";
import { messageOf } from "../../../lib/api.js";
import { useSavedDecks } from "../../../lib/deck.js";

export const Route = createFileRoute("/_site/decks/$deckId")({ component: EditDeck });

function EditDeck() {
  const { deckId } = Route.useParams();
  const { decks, failure } = useSavedDecks();
  // 読み直しに失敗しても、読めている一覧で組み続ける。ここで閉じると、保存していない変更が消える。
  if (decks.data === undefined) {
    return (
      <p className="note">
        {failure === null
          ? "デッキを読んでいます。"
          : `デッキを読めませんでした: ${messageOf(failure)}`}
      </p>
    );
  }
  const deck = decks.data.find((each) => each.deckId === deckId);
  if (deck === undefined) {
    return (
      <p className="note">
        このデッキは見つかりません。<Link to="/decks">デッキの一覧へ</Link>
      </p>
    );
  }
  // 別のデッキを開いたら、組みかけを持ち越さない。
  return <DeckBuilder key={deckId} saved={deck} />;
}
