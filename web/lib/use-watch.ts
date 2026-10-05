/**
 * 観戦の接続。観戦者が送るのは生きていることの `ping` だけである。
 *
 * 切れたら座席と同じく繋ぎ直す。断られたら、観戦は断っても誰も負けないので、そこでやめる。
 *
 * 届いた局面はすぐには描かず、`watch-frames.ts` に溜めて見る人の速さで送る。
 * 結果の文と記録の行は、届いた時点の盤面とカードの表で作って局面に添えておく。
 */

import { useEffect, useEffectEvent, useReducer, useState, type ActionDispatch } from "react";
import type { Player, PlayerView, SpectatorView } from "../../src/engine.js";
import type { ServerMessage } from "../../src/protocol.js";
import { useCardData } from "./cards.js";
import { keepAlive, reconnector, socketUrl } from "./connection.js";
import { describeMove, moveTargets } from "./describe-move.js";
import { describeEvents, noticesToShow, seatDisplayName, type Notice } from "./describe.js";
import { initialWatchState, watchReducer, type WatchState } from "./match-state.js";
import {
  initialPlayback,
  playbackReducer,
  type Playback,
  type PlaybackAction,
  type WatchFrame,
} from "./watch-frames.js";

export interface LoggedEvent {
  id: number;
  text: string;
}

export interface Watching {
  state: WatchState;
  /** 繋がっていないあいだの説明。繋がっていれば空。 */
  status: string;
  playback: Playback;
  control: ActionDispatch<[PlaybackAction]>;
}

/** `notify` は、繋いでいるあいだにサーバが返したエラー応答を、局面の送りを待たずに出す。 */
export function useWatch(token: string, notify: (notice: Notice) => void): Watching {
  const [state, setState] = useState(initialWatchState);
  const [status, setStatus] = useState("");
  const [playback, control] = useReducer(playbackReducer, undefined, initialPlayback);

  // 名前は届いた時点の表で引く。表が届いても繋ぎ直さない。
  const { table } = useCardData();
  const cardTable = useEffectEvent(() => table);
  const show = useEffectEvent(notify);

  useEffect(() => {
    let current = initialWatchState();
    let synced = false;
    let disposed = false;
    let socket: WebSocket | null = null;
    /** 直前に届いた局面の、両座席の射影。指された手の見出しは、指す直前の盤面から作る。 */
    let seatViews: [PlayerView, PlayerView] | null = null;
    /** 先攻のコイントスを見せたか。`spectator-sync` は繋ぎ直すたびに届くので、2 度は出さない。 */
    let firstPlayerShown = false;

    const who = (player: Player) => seatDisplayName(current.seats, player);
    const arrive = (frame: WatchFrame) => control({ t: "arrive", frame });

    const retry = reconnector(connect);
    connect();

    function connect() {
      const watching = new WebSocket(socketUrl(`spectatorToken=${encodeURIComponent(token)}`));
      socket = watching;
      /** 閉じる直前にサーバが言った理由。入れなかったときに、そのまま見せる。 */
      let refusal: string | null = null;
      let lost = false;
      let joined = false;
      keepAlive(watching, onLost);
      watching.addEventListener("message", (event: MessageEvent<string>) => {
        if (lost || disposed) return;
        const message = JSON.parse(event.data) as ServerMessage;
        const before = current;
        current = watchReducer(current, message);
        setState(current);
        switch (message.t) {
          case "spectator-sync": {
            synced = true;
            if (!joined) retry.connected();
            joined = true;
            setStatus("");
            const notices: Notice[] = [];
            // 対戦が始まったあとに開いた画面では、先攻はもう済んだ話なので出さない。
            if (!firstPlayerShown && message.view.phase === "setup") {
              firstPlayerShown = true;
              notices.push({
                text: `${who(message.firstPlayer)}が先攻です`,
                coins: { results: [true], faces: ["先攻", "後攻"] },
              });
            }
            seatViews = message.seatViews ?? null;
            arrive({
              stateVersion: message.stateVersion,
              ...board(message.view, seatViews),
              clock: message.clock,
              moved: null,
              lines: [],
              notices,
            });
            return;
          }
          case "spectator-delta": {
            const cards = cardTable();
            const moved =
              message.moved === undefined
                ? null
                : {
                    seat: message.moved.seat,
                    text: describeMove(message.moved.move, {
                      view: seatViews?.[message.moved.seat] ?? null,
                      cards,
                    }),
                    targets: moveTargets(message.moved.move),
                  };
            seatViews = message.seatViews ?? null;
            const notices = describeEvents(message.events, [current.view, before.view], who, cards);
            arrive({
              stateVersion: message.stateVersion,
              ...board(message.view, seatViews),
              clock: message.clock,
              moved,
              lines: notices.map((notice) => notice.text),
              notices: noticesToShow(notices),
            });
            return;
          }
          case "error":
            refusal = message.message;
            if (synced) show({ text: message.message, tone: "attention" });
            return;
          default:
            return;
        }
      });
      watching.addEventListener("close", onLost);

      function onLost() {
        if (lost || disposed) return;
        lost = true;
        if (current.ended !== null) {
          retry.stop();
          return;
        }
        if (!synced || refusal !== null) {
          retry.stop();
          setStatus(
            refusal === null
              ? "サーバへ繋がりませんでした。読み込み直すと、もう一度繋ぎます。"
              : `観戦できませんでした（${refusal}）`,
          );
          return;
        }
        const attempt = retry.schedule();
        setStatus(`接続が切れました。繋ぎ直しています（${attempt} 回目）`);
      }
    }

    return () => {
      disposed = true;
      retry.stop();
      socket?.close();
    };
  }, [token]);

  return { state, status, playback, control };
}

/** 局面のうち描くもの。座席の射影があれば、両者とも自分の側の射影で手札まで描く。 */
function board(
  view: SpectatorView,
  seatViews: [PlayerView, PlayerView] | null,
): Pick<WatchFrame, "open" | "sides" | "stadium"> {
  return {
    open: seatViews !== null,
    sides: seatViews === null ? view.players : [seatViews[0].self, seatViews[1].self],
    stadium: view.stadium,
  };
}
