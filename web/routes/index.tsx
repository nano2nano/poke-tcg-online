import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { z } from "zod";
import { Lobby } from "../components/lobby.js";
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
  const [seated, setSeated] = useState<StoredSeat | null>(storedSeat);
  const [status, setStatus] = useState("");
  const leave = useCallback((reason: string) => {
    setSeated(null);
    setStatus(reason);
  }, []);
  const sit = useCallback((next: StoredSeat) => {
    rememberSeat(next);
    setSeated(next);
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
      <Lobby status={status} onSeated={sit} />
    </>
  );
}
