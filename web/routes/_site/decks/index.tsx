import { createFileRoute } from "@tanstack/react-router";
import { DeckList } from "../../../components/deck-list.js";

export const Route = createFileRoute("/_site/decks/")({ component: DeckList });
