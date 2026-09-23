import { defineConfig } from "vitest/config";
import { cardIdsOf, engineIdentity } from "./tools/engine-identity.js";

const identity = engineIdentity();

export default defineConfig({
  // Worker のビルドが埋める値と同じものを埋める（`tools/build-worker.ts`）。
  define: {
    __ENGINE_COMMIT__: JSON.stringify(identity.commit),
    __CARD_DATA_SHA256__: JSON.stringify(identity.cardDataSha256),
    __CARD_IDS__: JSON.stringify(cardIdsOf(identity.cardDataText)),
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
