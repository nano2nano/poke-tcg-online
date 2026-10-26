import { memo, useState } from "react";
import type { LoggedEvent } from "../lib/use-watch.js";

/**
 * 対戦ログ。盤面に重ねず、横に広い画面では右の欄に、狭い画面では下の端に置く（`styles.css`）。
 * 狭い画面には盤面の横に空きが無いので、畳んでいるあいだは最新の 1 行だけを出す。
 *
 * 対戦が長いと行が増え続ける。盤面の演出が出入りするたびには描き直さない。
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
  const [open, setOpen] = useState(false);
  return (
    <section id={id} className="event-log" data-open={open ? "" : undefined}>
      <div className="event-log-head">
        <h2>対戦ログ</h2>
        <button
          className="event-log-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen(!open)}
        >
          {open ? "閉じる" : "すべて見る"}
        </button>
      </div>
      <ol id={listId} className="events" aria-live="polite">
        {events.map((event) => (
          <li key={event.id} data-tone={event.tone}>
            {event.text}
          </li>
        ))}
      </ol>
    </section>
  );
});
