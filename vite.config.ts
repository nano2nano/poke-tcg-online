import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { embedCardData } from "./tools/embed-card-data.js";
import { cardIdsOf, engineIdentity } from "./tools/engine-identity.js";
import { BASEPATH } from "./web/basepath.js";

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
    tanstackStart({ srcDirectory: "web", router: { basepath: BASEPATH } }),
    viteReact(),
  ],
});
