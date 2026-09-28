import { memo } from "react";
import type { LoggedEvent } from "../lib/use-watch.js";

/**
 * 起きたことの記録。結果は画面の上の端に出すので、ここは見逃したものを後から辿るときと、
 * 不具合を調べるとき用である。
 *
 * 対戦が長いと行が増え続ける。結果の通知が出入りするたびには描き直さない。
 */
export const EventLog = memo(function EventLog({
  id,
  listId,
  events,
}: {
  id: string;
  listId: string;
  events: LoggedEvent[];
}) {
  return (
    <details id={id} className="event-log">
      <summary>できごとの記録</summary>
      <ol id={listId} className="events">
        {events.map((event) => (
          <li key={event.id}>{event.text}</li>
        ))}
      </ol>
    </details>
  );
});
