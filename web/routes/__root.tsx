import type { ReactNode } from "react";
import { HeadContent, Navigate, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { CardPreview } from "../components/card-preview.js";
import { CardZoom } from "../components/card-zoom.js";
import { CardDataProvider } from "../lib/cards.js";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ポケカ オンライン対戦" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  // SSR はしないが、文書の骨組みとスクリプトの読み込みはビルドが `index.html` へ書き出す。
  shellComponent: Document,
  component: Root,
  notFoundComponent: ElsewhereToHome,
});

function Root() {
  return (
    <CardDataProvider>
      <CardZoom>
        <Outlet />
        <CardPreview />
      </CardZoom>
    </CardDataProvider>
  );
}

/**
 * 画面のパスは `/` だけなので、ほかのパスは検索の部分を残して `/` へ移す。画面を入れ替える前に
 * `/next/` で配った観戦のリンクも、これで開ける。
 */
function ElsewhereToHome() {
  return <Navigate to="/" search={true} replace />;
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
