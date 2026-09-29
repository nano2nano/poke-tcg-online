import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { embedCardData } from "./tools/embed-card-data.js";
import { cardIdsOf, engineIdentity } from "./tools/engine-identity.js";

const identity = engineIdentity();

export default defineConfig({
  // テスト（`vitest.config.ts`）も同じ値を埋める。
  define: {
    __ENGINE_COMMIT__: JSON.stringify(identity.commit),
    __CARD_DATA_SHA256__: JSON.stringify(identity.cardDataSha256),
    __CARD_IDS__: JSON.stringify(cardIdsOf(identity.cardDataText)),
  },
  plugins: [
    embedCardData(identity),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // 画面の骨組みをビルドで `index.html` に書き出し、ページは Worker を通さず静的アセットで返す。
    tanstackStart({
      srcDirectory: "web",
      spa: { enabled: true, prerender: { outputPath: "/index.html" } },
    }),
    viteReact(),
  ],
});
