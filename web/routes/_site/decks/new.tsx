import { createFileRoute } from "@tanstack/react-router";
import { DeckBuilder } from "../../../components/deck-builder.js";

export const Route = createFileRoute("/_site/decks/new")({ component: NewDeck });

function NewDeck() {
  return <DeckBuilder saved={null} />;
}
