import { createFileRoute, redirect } from "@tanstack/react-router";

/** 画面のパスは `/` だけなので、ほかのパスは検索の部分を残して `/` へ移す。 */
export const Route = createFileRoute("/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: true, replace: true });
  },
});
