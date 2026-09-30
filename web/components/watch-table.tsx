import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import type { Player } from "../../src/engine.js";
import { seatDisplayName, watchClockText, watchEndText } from "../lib/describe.js";
import type { LoggedEvent } from "../lib/use-watch.js";
import { useWatch } from "../lib/use-watch.js";
import {
  STEP_CHOICES,
  stepMsOf,
  type Playback,
  type PlaybackAction,
  type WatchFrame,
} from "../lib/watch-frames.js";
import type { WatchState } from "../lib/match-state.js";
import { Board, NOTHING_AIMED, SideBoard, Stadium, type AimedSet } from "./board.js";
import { EventLog } from "./event-log.js";
import { SettingsButton } from "./settings.js";
import { NoticeLayer, useNotices } from "./notices.js";

/**
 * 観戦の卓。自分の座席は無いので、座席 0 を手前に置く。
 *
 * 局面は届いたものを溜めて、1 手の演出が終わってから選んだ間を置いて送る。止めて 1 手ずつ進めることも、戻ることもできる。
 *
 * 卓の配置の CSS は `body` の直下にある卓を探すので、外側を別の要素で包まない。
 */
export function WatchTable({ token }: { token: string }) {
  const board = useRef<HTMLElement>(null);
  const feed = useNotices();
  const { state, status, playback, control } = useWatch(token, feed.show);
  const { seats, ended } = state;
  const { frames, at, stepped } = playback;
  const frame = frames[at] ?? null;
  const open = frames[0]?.open === true;
  const atEnd = at === frames.length - 1;
  const who = (player: Player) => seatDisplayName(seats, player);

  // 届いた順に進んだときだけ、進んだぶんの結果を出す。届きしだい描くと、1 度に何手も進むことがある。
  const show = feed.show;
  const announced = useRef(-1);
  useEffect(() => {
    if (stepped) {
      for (const passed of frames.slice(announced.current + 1, at + 1)) {
        for (const notice of passed.notices) show(notice);
      }
    }
    announced.current = at;
  }, [at, stepped, frames, show]);
  // 次の局面へ送るまでの長さは、いま出した結果から測る。結果を出す effect より後に置く。
  useTicker(playback, control, feed.remainingMs);

  // 決着は、描いている局面が最後に届いたものに追いついたときに出す。
  const endShown = useRef(false);
  const reachedEnd = ended !== null && atEnd;
  useEffect(() => {
    if (!reachedEnd || endShown.current || ended === null) return;
    endShown.current = true;
    show({ text: watchEndText(ended.matchResult, (player) => seatDisplayName(seats, player)) });
  }, [reachedEnd, ended, seats, show]);

  const events = useMemo(() => loggedUpTo(frames, at), [frames, at]);
  const aimed = useMemo<AimedSet>(
    () => (frame?.moved == null ? NOTHING_AIMED : new Set(frame.moved.targets)),
    [frame],
  );

  // AI どうしの対戦では時計を出さない。AI は持ち時間を使い切らず、届いた時点の残りは見ている局面とずれる。
  const clockText = reachedEnd
    ? watchEndText(ended.matchResult, who)
    : frame?.clock != null && !open
      ? watchClockText(frame.clock, who)
      : "";

  return (
    <>
      <section id="watch" className="table" ref={board} data-open={open ? "" : undefined}>
        <div className="table-status">
          <h2>観戦</h2>
          <p className="note">
            {open
              ? "AI どうしの対戦です。両者の手札も見えます。"
              : "両者とも、相手から見えるのと同じだけが見えます。手札の中身は出ません。"}
          </p>
          <div id="watch-clock" className="clock">
            {clockText}
          </div>
          <Controls playback={playback} control={control} />
          {open && (
            <p id="watch-move" className="watch-move">
              {frame?.moved != null && `${who(frame.moved.seat)}: ${frame.moved.text}`}
            </p>
          )}
          <p>
            <output id="watch-status">{status}</output>
          </p>
          {open && (
            <p>
              <Link to="/watch">観戦のページへ戻る</Link>
            </p>
          )}
        </div>
        <Board
          name="watch"
          near={frame?.sides[0] ?? null}
          far={frame?.sides[1] ?? null}
          stadium={frame?.stadium ?? null}
        >
          <SeatSide state={state} frame={frame} player={1} aimed={aimed} />
          <div id="watch-stadium" className="board-center">
            {frame !== null && <Stadium stadium={frame.stadium} />}
          </div>
          <SeatSide state={state} frame={frame} player={0} aimed={aimed} />
        </Board>
        <div className="table-panel">
          <EventLog id="watch-event-log" listId="watch-events" events={events} />
        </div>
      </section>
      <NoticeLayer feed={feed} board={board} />
    </>
  );
}

/**
 * 再生しているあいだ、いまの局面の演出が終わってから選んだ間を置いて、1 手ずつ送る。
 * 届きしだいのときは届いた側が送る。
 */
function useTicker(
  playback: Playback,
  control: (action: PlaybackAction) => void,
  remainingMs: () => number,
) {
  const stepMs = stepMsOf(playback);
  const { at, playing } = playback;
  const behind = at < playback.frames.length - 1;
  useEffect(() => {
    if (!playing || !behind || stepMs === 0) return;
    const timer = setTimeout(() => control({ t: "tick" }), remainingMs() + stepMs);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- 1 手送るたびに、その局面の演出から測り直す。
  }, [at, playing, behind, stepMs, control, remainingMs]);
}

function Controls({
  playback,
  control,
}: {
  playback: Playback;
  control: (action: PlaybackAction) => void;
}) {
  const { frames, at, playing } = playback;
  const last = frames.length - 1;
  const shown = frames[at]?.stateVersion ?? 0;
  const latest = frames[last]?.stateVersion ?? 0;
  return (
    <div id="watch-controls" className="watch-controls">
      <div className="watch-buttons">
        <button id="watch-back" disabled={at <= 0} onClick={() => control({ t: "back" })}>
          1 手戻る
        </button>
        <button id="watch-play" onClick={() => control({ t: playing ? "pause" : "play" })}>
          {playing ? "止める" : "再生する"}
        </button>
        <button id="watch-forward" disabled={at >= last} onClick={() => control({ t: "forward" })}>
          1 手進む
        </button>
        <button id="watch-latest" disabled={at >= last} onClick={() => control({ t: "latest" })}>
          最新へ
        </button>
      </div>
      <label>
        演出のあとの間{" "}
        <select
          id="watch-speed"
          value={stepMsOf(playback)}
          onChange={(event) => control({ t: "speed", stepMs: Number(event.target.value) })}
        >
          {STEP_CHOICES.map(({ ms, label }) => (
            <option key={ms} value={ms}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <SettingsButton id="watch-settings-button" />
      <p
        id="watch-position"
        className="note"
        data-shown={frames.length === 0 ? undefined : shown}
        data-latest={frames.length === 0 ? undefined : latest}
      >
        {shown === latest ? `${shown} 手目` : `${shown} 手目（届いているのは ${latest} 手目まで）`}
      </p>
    </div>
  );
}

/** 描いている局面までの記録。新しいものが先頭。 */
function loggedUpTo(frames: readonly WatchFrame[], at: number): LoggedEvent[] {
  const logged: LoggedEvent[] = [];
  for (const frame of frames.slice(0, at + 1)) {
    for (const text of frame.lines) logged.push({ id: logged.length + 1, text });
  }
  return logged.reverse();
}

/** 座席 1 は向かいに座る側として、上下と左右を返して描く。 */
function SeatSide({
  state: { seats },
  frame,
  player,
  aimed,
}: {
  state: WatchState;
  frame: WatchFrame | null;
  player: Player;
  aimed: AimedSet;
}) {
  const seat = seats?.[player];
  // レーティングの無い座席は AI である。
  const name =
    seat === undefined
      ? `座席 ${player}`
      : `${seat.displayName}（${seat.rating === null ? "AI" : seat.rating}）`;
  const side = frame?.sides[player] ?? null;
  return (
    <div className="board-side">
      <h2 id={`watch-name-${player}`}>{name}</h2>
      <div id={`watch-side-${player}`}>
        {side !== null && <SideBoard side={side} mirrored={player === 1} aimed={aimed} />}
      </div>
    </div>
  );
}
