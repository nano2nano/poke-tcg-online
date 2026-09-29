import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * 画面のパスは `/` だけなので、ほかのパスは検索の部分を残して `/` へ移す。画面を入れ替える前に
 * `/next/` で配った観戦のリンクも、これで開ける。
 */
export const Route = createFileRoute("/$")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: true, replace: true });
  },
});
