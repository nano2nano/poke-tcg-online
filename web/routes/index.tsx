import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { z } from "zod";
import { History } from "../components/history.js";
import { Lobby } from "../components/lobby.js";
import { refreshAccount } from "../lib/account.js";
import { SeatTable } from "../components/seat-table.js";
import { SettingsButton } from "../components/settings.js";
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
    (reason: string, resumable: boolean) => {
      // 戻す先は離れた座席である。覚えている座席は別のタブが置き換えていることがあり、そこへ繋ぐと
      // そのタブの接続を追い出す。
      setRemembered(resumable ? seated : null);
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
  // 一覧とリプレイは同じ位置に置き、座るときと離れるときに開いているリプレイを閉じない。
  return (
    <>
      {seated !== null ? (
        <SeatTable key={seated.seatToken} seated={seated} onLeave={leave} />
      ) : (
        <>
          <header id="home">
            <h1>ポケカ オンライン対戦</h1>
            <p className="note">
              盤面は卓と同じ配置で描き、指せる手はサーバが送ってきたものをそのまま並べます。
              カードにマウスを載せる（タッチ端末では長押しする）と大きく出ます。押すと、進化前やついているカードもまとめて出ます。
            </p>
            <SettingsButton id="home-settings-button" />
          </header>
          <Lobby status={status} remembered={remembered} onSeated={sit} onResume={resume} />
        </>
      )}
      <History />
    </>
  );
}
