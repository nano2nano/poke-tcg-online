import { createFileRoute } from "@tanstack/react-router";
import { History } from "../../components/history.js";

export const Route = createFileRoute("/_site/history")({ component: History });
