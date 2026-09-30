import { createFileRoute } from "@tanstack/react-router";
import { BotWatchForm } from "../../components/bot-watch.js";

export const Route = createFileRoute("/_site/watch")({ component: BotWatchForm });
