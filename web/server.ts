/**
 * Worker の入口。API と WebSocket は対戦サーバへ渡し、ほかのパスは TanStack Start に渡す。
 *
 * 画面は静的アセットで返り（`wrangler.jsonc` の `assets`）、本番の Worker には API と WebSocket しか来ない。
 * Start へ渡すのは、ビルドで画面の骨組みを `index.html` へ書き出すときのためである。
 */

import server, { Server, type Env } from "../src/worker.js";

export { Server };

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    // `wrangler.jsonc` の `run_worker_first` と同じパスを対戦サーバへ渡す。
    if (pathname === "/ws" || pathname.startsWith("/api/")) return server.fetch(request, env);
    return renderPage(request);
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
