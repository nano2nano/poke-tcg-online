import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main id="next-home">
      <h1>ポケカ オンライン対戦</h1>
      <p>
        新しい画面を作っているところです。対戦は <a href="/">いまの画面</a> からできます。
      </p>
    </main>
  );
}
