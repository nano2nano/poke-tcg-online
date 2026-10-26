import { memo, useState } from "react";
import type { LogEntry } from "../lib/event-log.js";

/**
 * 対戦ログ。新しいまとまりが先頭。カードやワザを使ったことを見出しに、その効果で起きたことを下に並べる。
 * 狭い画面には盤面の横に空きが無く、下の端に出すので、畳んでいるあいだは最新の 1 行だけを見せる（`styles.css`）。
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
  events: LogEntry[];
}) {
  const [open, setOpen] = useState(false);
  const newest = events[0];
  const latest = newest?.details.at(-1) ?? newest;
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
      {/* 畳んだバーに出す最新の行。読み上げは下の一覧がする。 */}
      {latest !== undefined && (
        <p key={latest.id} className="event-latest" data-tone={latest.tone} aria-hidden>
          {latest.text}
        </p>
      )}
      <ol id={listId} className="events" aria-live="polite">
        {events.map((entry) => (
          <li key={entry.id} data-tone={entry.tone}>
            <span className="event-head">{entry.text}</span>
            {entry.details.length > 0 && (
              <ul className="event-details">
                {entry.details.map((detail) => (
                  <li key={detail.id} data-tone={detail.tone}>
                    {detail.text}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
});
