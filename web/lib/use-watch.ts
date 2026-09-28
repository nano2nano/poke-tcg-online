/**
 * 観戦の接続。観戦者が送るのは生きていることの `ping` だけである。
 *
 * 切れたら座席と同じく繋ぎ直す。断られたら、観戦は断っても誰も負けないので、そこでやめる。
 */

import { useEffect, useEffectEvent, useState } from "react";
import type { Player } from "../../src/engine.js";
import type { ServerMessage } from "../../src/protocol.js";
import { useCardData } from "./cards.js";
import { keepAlive, reconnector, socketUrl } from "./connection.js";
import { describeEvents, seatDisplayName, watchEndText, type Notice } from "./describe.js";
import { initialWatchState, watchReducer, type WatchState } from "./match-state.js";

export interface LoggedEvent {
  id: number;
  text: string;
}

export interface Watching {
  state: WatchState;
  /** 繋がっていないあいだの説明。繋がっていれば空。 */
  status: string;
  /** 新しいものが先頭。 */
  events: LoggedEvent[];
}

export function useWatch(token: string, notify: (notice: Notice) => void): Watching {
  const [state, setState] = useState(initialWatchState);
  const [status, setStatus] = useState("");
  const [events, setEvents] = useState<LoggedEvent[]>([]);

  // 名前は届いた時点の表で引く。表が届いても繋ぎ直さない。
  const { table } = useCardData();
  const cardTable = useEffectEvent(() => table);
  const show = useEffectEvent(notify);

  useEffect(() => {
    let current = initialWatchState();
    let synced = false;
    let disposed = false;
    let socket: WebSocket | null = null;
    let logged = 0;
    /** 先攻のコイントスを見せたか。`spectator-sync` は繋ぎ直すたびに届くので、2 度は出さない。 */
    let firstPlayerShown = false;

    const who = (player: Player) => seatDisplayName(current.seats, player);
    const log = (texts: string[]) => {
      if (texts.length === 0) return;
      const added = texts.map((text) => ({ id: (logged += 1), text })).reverse();
      setEvents((shown) => [...added, ...shown]);
    };

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
          case "spectator-sync":
            synced = true;
            if (!joined) retry.connected();
            joined = true;
            setStatus("");
            // 対戦が始まったあとに開いた画面では、先攻はもう済んだ話なので出さない。
            if (!firstPlayerShown && message.view.phase === "setup") {
              firstPlayerShown = true;
              show({
                text: `コイントスの結果、${who(message.firstPlayer)}が先攻です`,
                coins: { results: [true], faces: ["先攻", "後攻"] },
              });
            }
            return;
          case "spectator-delta": {
            const notices = describeEvents(
              message.events,
              [current.view, before.view],
              who,
              cardTable(),
            );
            log(
              message.events.flatMap((happened, index) => {
                const notice = notices[index];
                return notice?.repeated ? [] : [notice?.text ?? happened.kind];
              }),
            );
            for (const notice of notices) {
              if (notice !== null && !notice.repeated) show(notice);
            }
            return;
          }
          case "spectator-ended":
            show({ text: watchEndText(message.matchResult, who) });
            return;
          case "error":
            refusal = message.message;
            if (synced) {
              log([message.message]);
              show({ text: message.message, tone: "attention" });
            }
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

  return { state, status, events };
}
