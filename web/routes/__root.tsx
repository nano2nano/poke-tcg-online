import type { ReactNode } from "react";
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { CardPreview } from "../components/card-preview.js";
import { CardZoom } from "../components/card-zoom.js";
import { MotionSettingProvider } from "../components/motion-setting.js";
import { Settings } from "../components/settings.js";
import { CardDataProvider } from "../lib/cards.js";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ポケカ オンライン対戦" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      // 目印は要らないが、無いとブラウザが毎回 `/favicon.ico` を取りに行く。空の 1 枚を埋めておく。
      { rel: "icon", href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
    ],
  }),
  // SSR はしないが、文書の骨組みとスクリプトの読み込みはビルドが `index.html` へ書き出す。
  shellComponent: Document,
  component: Root,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main id="not-found" className="page">
      <h1>ページが見つかりません</h1>
      <p>
        <Link to="/">トップへ戻る</Link>
      </p>
    </main>
  );
}

function Root() {
  return (
    <MotionSettingProvider>
      <Settings>
        <CardDataProvider>
          <CardZoom>
            <Outlet />
            <CardPreview />
          </CardZoom>
        </CardDataProvider>
      </Settings>
    </MotionSettingProvider>
  );
}

function Document({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
