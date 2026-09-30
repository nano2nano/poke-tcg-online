import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { SeatTable } from "../components/seat-table.js";
import { refreshAccount } from "../lib/account.js";
import { storedSeat } from "../lib/seat.js";

export const Route = createFileRoute("/match")({ component: Match });

/**
 * 座席の卓。ロビーから渡された座席か、覚えている座席へ繋ぐ。
 *
 * **カードの名前の表を待たずに繋ぐ。** 指していないあいだも時計は流れるので（3.4 節）、
 * 取りに行っているあいだに手番が終わる。
 */
function Match() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const passed = useLocation({ select: (location) => location.state.seat });
  const [seated] = useState(() => passed ?? storedSeat());
  const leave = useCallback(
    (reason: string, resumable: boolean) => {
      // 離れているあいだに決着していれば、レーティングが動いている。
      refreshAccount(queryClient).catch(() => {});
      // 戻す先は離れた座席である。覚えている座席は別のタブが置き換えていることがあり、そこへ繋ぐと
      // そのタブの接続を追い出す。
      void navigate({
        to: "/",
        replace: true,
        state: { left: { reason, seat: resumable ? seated : null } },
      });
    },
    [seated, queryClient, navigate],
  );
  if (seated === null) return <Navigate to="/" replace />;
  return <SeatTable key={seated.seatToken} seated={seated} onLeave={leave} />;
}
