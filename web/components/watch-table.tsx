import { memo, useRef } from "react";
import type { Player } from "../../src/engine.js";
import { seatDisplayName, watchClockText, watchEndText } from "../lib/describe.js";
import type { WatchState } from "../lib/match-state.js";
import { useWatch, type LoggedEvent } from "../lib/use-watch.js";
import { SideBoard, Stadium } from "./board.js";
import { NoticeLayer, useNotices } from "./notices.js";

/**
 * 観戦の卓。自分の座席は無いので、座席 0 を手前に置く。
 *
 * 卓の配置の CSS は `body` の直下にある卓を探すので、外側を別の要素で包まない。
 */
export function WatchTable({ token }: { token: string }) {
  const board = useRef<HTMLElement>(null);
  const feed = useNotices();
  const { state, status, events } = useWatch(token, feed.show);
  const { view, seats, clock, ended } = state;
  const who = (player: Player) => seatDisplayName(seats, player);

  const clockText =
    ended !== null
      ? watchEndText(ended.matchResult, who)
      : clock !== null
        ? watchClockText(clock, who)
        : "";

  return (
    <>
      <section id="watch" className="table" ref={board}>
        <div className="table-status">
          <h2>観戦</h2>
          <p className="note">
            両者とも、相手から見えるのと同じだけが見えます。手札の中身は出ません。
          </p>
          <div id="watch-clock" className="clock">
            {clockText}
          </div>
          <p>
            <output id="watch-status">{status}</output>
          </p>
        </div>
        <div className="board">
          <SeatSide state={state} player={1} />
          <div id="watch-stadium" className="board-center">
            {view !== null && <Stadium stadium={view.stadium} />}
          </div>
          <SeatSide state={state} player={0} />
        </div>
        <div className="table-panel">
          <EventLog events={events} />
        </div>
      </section>
      <NoticeLayer feed={feed} board={board} />
    </>
  );
}

/** 座席 1 は向かいに座る側として、上下と左右を返して描く。 */
function SeatSide({ state: { view, seats }, player }: { state: WatchState; player: Player }) {
  const seat = seats?.[player];
  // レーティングの無い座席は AI である。
  const name =
    seat === undefined
      ? `座席 ${player}`
      : `${seat.displayName}（${seat.rating === null ? "AI" : seat.rating}）`;
  return (
    <div className="board-side">
      <h2 id={`watch-name-${player}`}>{name}</h2>
      <div id={`watch-side-${player}`}>
        {view !== null && <SideBoard side={view.players[player]} mirrored={player === 1} />}
      </div>
    </div>
  );
}

/** 対戦が長いと行が増え続ける。結果の通知が出入りするたびには描き直さない。 */
const EventLog = memo(function EventLog({ events }: { events: LoggedEvent[] }) {
  return (
    <details id="watch-event-log" className="event-log">
      <summary>できごとの記録</summary>
      <ol id="watch-events" className="events">
        {events.map((event) => (
          <li key={event.id}>{event.text}</li>
        ))}
      </ol>
    </details>
  );
});
