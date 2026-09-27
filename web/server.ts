/**
 * Worker の入口。新しい画面のパスだけを TanStack Start に渡し、ほかはこれまでどおり対戦サーバへ渡す。
 *
 * 画面は静的アセットとして返るので（`wrangler.jsonc` の `assets`）、API と WebSocket のほかにここへ来るのは、
 * アセットに無いパスだけである。
 */

import server, { Server, type Env } from "../src/worker.js";
import { BASEPATH } from "./basepath.js";

export { Server };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === BASEPATH || pathname.startsWith(`${BASEPATH}/`)) return renderPage(request);
    return server.fetch(request, env);
  },
};

/**
 * TanStack Start は画面のパスで初めて読み込む。先頭で import すると、API と WebSocket を受けるだけの
 * isolate（Durable Object を含む）まで、起動のたびに React とルーターを評価する。
 */
async function renderPage(request: Request): Promise<Response> {
  const { default: handler } = await import("@tanstack/react-start/server-entry");
  return handler.fetch(request);
}
