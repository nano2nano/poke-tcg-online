import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { z } from "zod";
import { Lobby } from "../components/lobby.js";
import { refreshAccount } from "../lib/account.js";
import { SeatTable } from "../components/seat-table.js";
import { WatchTable } from "../components/watch-table.js";
import { rememberSeat, storedSeat, type StoredSeat } from "../lib/seat.js";

const search = z.object({
  /** 観戦のリンクが運ぶ観戦トークン。 */
  watch: z.string().optional(),
});

export const Route = createFileRoute("/")({ validateSearch: search, component: Home });

function Home() {
  const { watch } = Route.useSearch();
  if (watch !== undefined) return <WatchTable key={watch} token={watch} />;
  return <Seat />;
}

/**
 * 覚えている座席があれば、そこへ繋ぎ直す。観戦で開いたときは繋がない。繋ぐと観戦の画面の裏で
 * 対戦が開き、どちらを見ているのか分からなくなる。
 *
 * **カードの名前の表を待たずに繋ぐ。** 指していないあいだも時計は流れるので（3.4 節）、
 * 取りに行っているあいだに手番が終わる。
 */
function Seat() {
  const queryClient = useQueryClient();
  const [seated, setSeated] = useState<StoredSeat | null>(storedSeat);
  const [status, setStatus] = useState("");
  /** 離れたあとも覚えている座席。繋がらなかっただけなら、まだ指していた対戦が続いている。 */
  const [remembered, setRemembered] = useState<StoredSeat | null>(null);
  const leave = useCallback(
    (reason: string) => {
      // 別のタブが置いた座席へは戻らせない。こちらで繋ぐと、そのタブの接続を追い出す。
      const stored = storedSeat();
      setRemembered(stored?.seatToken === seated?.seatToken ? stored : null);
      // 離れているあいだに決着していれば、レーティングが動いている。
      refreshAccount(queryClient).catch(() => {});
      setSeated(null);
      setStatus(reason);
    },
    [seated, queryClient],
  );
  const sit = useCallback((next: StoredSeat) => {
    rememberSeat(next);
    setSeated(next);
    setStatus("");
  }, []);
  /** 覚え直さない。離れてから別のタブが新しい対戦の座席を置いていれば、そちらを残す。 */
  const resume = useCallback((back: StoredSeat) => {
    setSeated(back);
    setStatus("");
  }, []);
  if (seated !== null) return <SeatTable key={seated.seatToken} seated={seated} onLeave={leave} />;
  return (
    <>
      <header id="next-home">
        <h1>ポケカ オンライン対戦</h1>
        <p className="note">
          新しい画面を作っているところです。デッキを組む画面と、リプレイと戦績は{" "}
          <a href="/">いまの画面</a> にあります。
        </p>
      </header>
      <Lobby status={status} remembered={remembered} onSeated={sit} onResume={resume} />
    </>
  );
}
