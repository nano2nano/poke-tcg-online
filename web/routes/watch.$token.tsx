import { createFileRoute } from "@tanstack/react-router";
import { WatchTable } from "../components/watch-table.js";

/** 観戦のリンクが開く卓。観戦トークンで繋ぎ、プレイヤーは作らない。 */
export const Route = createFileRoute("/watch/$token")({ component: Watch });

function Watch() {
  const { token } = Route.useParams();
  return <WatchTable key={token} token={token} />;
}
