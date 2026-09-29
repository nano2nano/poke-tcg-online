import type { ReactNode } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
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
