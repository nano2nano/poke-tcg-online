import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import type { StoredSeat } from "./lib/seat.js";
import { routeTree } from "./routeTree.gen.js";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** ロビーから卓へ渡す座席。 */
    seat?: StoredSeat;
    /** 卓を離れた理由と、繋がらなかっただけなら戻る座席。卓からロビーへ渡す。 */
    left?: { reason: string; seat: StoredSeat | null };
  }
}

export function getRouter() {
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
