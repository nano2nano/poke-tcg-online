import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // 回り道の理由は `tests/node-sqlite-shim.ts` にある。
    alias: {
      "node:sqlite": fileURLToPath(new URL("./tests/node-sqlite-shim.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
