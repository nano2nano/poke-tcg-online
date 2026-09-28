import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { BASEPATH } from "./basepath.js";
import { routeTree } from "./routeTree.gen.js";

export function getRouter() {
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    basepath: BASEPATH,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}
