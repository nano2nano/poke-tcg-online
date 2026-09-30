import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { Lobby } from "../../components/lobby.js";
import { rememberSeat, storedSeat } from "../../lib/seat.js";

/**
 * 対戦に入るページ。指している座席を覚えていれば、対戦の卓へ移って繋ぎ直す。
 * 指していないあいだも時計は流れる（仕様 3.4 節）。
 *
 * 卓から離れて戻ってきたときは移らない。離れた理由と、繋がらなかっただけなら戻る道を出す。
 *
 * 移るかどうかは部品の中でなく `beforeLoad` で決める。部品は、ここから離れる途中にも行き先の
 * 位置で描き直されるので、そこで移すと行き先へ渡した座席を落とす。
 */
export const Route = createFileRoute("/_site/")({
  beforeLoad: ({ location }) => {
    if (location.state.left === undefined && storedSeat() !== null) {
      throw redirect({ to: "/match", replace: true });
    }
  },
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const left = useLocation({ select: (location) => location.state.left });
  return (
    <Lobby
      status={left?.reason ?? ""}
      remembered={left?.seat ?? null}
      onSeated={(seat) => {
        rememberSeat(seat);
        void navigate({ to: "/match", state: { seat } });
      }}
      // 覚え直さない。離れてから別のタブが新しい対戦の座席を置いていれば、そちらを残す。
      onResume={(seat) => void navigate({ to: "/match", state: { seat } })}
    />
  );
}
