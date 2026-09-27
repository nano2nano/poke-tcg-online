import { createStart } from "@tanstack/react-start";

// SSR はしない（`docs/spec/battle-server.md` 3.1 節）。
export const startInstance = createStart(() => ({ defaultSsr: false }));
