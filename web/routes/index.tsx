import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { WatchTable } from "../components/watch-table.js";

const search = z.object({
  /** 観戦のリンクが運ぶ観戦トークン。 */
  watch: z.string().optional(),
});

export const Route = createFileRoute("/")({ validateSearch: search, component: Home });

function Home() {
  const { watch } = Route.useSearch();
  // リンクを開き直したら、前の対戦の盤面とできごとを持ち越さない。
  if (watch !== undefined) return <WatchTable key={watch} token={watch} />;
  return (
    <main id="next-home">
      <h1>ポケカ オンライン対戦</h1>
      <p>
        新しい画面を作っているところです。対戦は <a href="/">いまの画面</a> からできます。
      </p>
    </main>
  );
}
