import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { SettingsButton } from "../components/settings.js";

/** 対戦と観戦の卓のほかのページ。卓は画面いっぱいに描くので、この枠に入れない。 */
export const Route = createFileRoute("/_site")({ component: Site });

function Site() {
  return (
    <>
      <header className="site-header">
        <Link to="/" className="site-title">
          ポケカ オンライン対戦
        </Link>
        <nav className="site-nav">
          <Link to="/" activeOptions={{ exact: true }}>
            対戦
          </Link>
          <Link to="/decks">デッキ</Link>
          <Link to="/history">対戦の記録</Link>
          <Link to="/watch">観戦</Link>
        </nav>
        <SettingsButton id="site-settings-button" />
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
