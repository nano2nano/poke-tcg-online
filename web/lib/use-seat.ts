/**
 * 着いている座席への接続。切れたら同じ座席トークンで繋ぎ直す（3.3 節）。
 * 切断中も時計は流れる（3.4 節）ので、読み込み直すのを待っていると、そのあいだに負ける。
 */

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Player } from "../../src/engine.js";
import type { ClientMessage, ServerMessage } from "../../src/protocol.js";
import { refreshAccount } from "./account.js";
import { useCardData } from "./cards.js";
import { keepAlive, reconnector, socketUrl, type Reconnector } from "./connection.js";
import {
  describeEvents,
  eventLines,
  rejectText,
  seatEndText,
  seatEndTone,
  type Notice,
} from "./describe.js";
import { initialSeatState, seatReducer, type SeatState, type SetupAction } from "./match-state.js";
import { checkShuffle, forgetSeat, type ShuffleCheck, type StoredSeat } from "./seat.js";
import type { LoggedEvent } from "./use-watch.js";

/** 繋がっていないあいだの様子。繋がっていれば null。 */
export type Connection = { state: "reconnecting" | "replaced"; text: string } | null;

export interface Seating {
  state: SeatState;
  connection: Connection;
  /** 新しいものが先頭。 */
  events: LoggedEvent[];
  shuffle: { result: ShuffleCheck; text: string } | null;
  /** 座席を離れた理由。座席を失ったときと、座席へ繋がらなかったときに入る。 */
  left: string | null;
  /**
   * 手か準備の答えを送って、返事を待っているあいだ。続けて押すと、2 つ目は古い局面への手として
   * 断られ、通った 1 つ目まで通らなかったように見える。
   */
  awaiting: boolean;
  send: (message: ClientMessage) => void;
  choose: (action: SetupAction) => void;
}

/**
 * 同じ座席を開いたタブどうしで、繋がったことを知らせ合う。繋ぎ直しを待っているタブが
 * あとから繋ぐと、いま指しているタブがサーバに閉じられる（3.3 節）。
 */
const CHANNEL = "poke-seat";

const REPLY_WAIT_MS = 10_000;

export function useSeat(seated: StoredSeat, notify: (notice: Notice) => void): Seating {
  const [state, setState] = useState(() => initialSeatState(seated.seat));
  const [connection, setConnection] = useState<Connection>(null);
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [shuffle, setShuffle] = useState<Seating["shuffle"]>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(false);

  const { table } = useCardData();
  const cardTable = useEffectEvent(() => table);
  const show = useEffectEvent(notify);
  const queryClient = useQueryClient();
  const refreshRating = useEffectEvent(() => refreshAccount(queryClient).catch(() => {}));

  /** いまの状態と接続。ボタンから読むので、描いた時点の値ではなく最新を持つ。 */
  const live = useRef<{ state: SeatState; socket: WebSocket | null; log: (text: string) => void }>({
    state,
    socket: null,
    log: () => {},
  });

  useEffect(() => {
    let logged = 0;
    let disposed = false;
    /** 一度でも `sync` か `pending` が届いたか。届いていれば、サーバはこの座席を知っている。 */
    let known = false;
    let ended = false;
    let replaced = false;
    /** 先攻のコイントスを見せたか。`sync` は繋ぎ直すたびに届くので、2 度は出さない。 */
    let firstPlayerShown = false;

    const who = (player: Player) => (player === seated.seat ? "あなた" : "相手");
    const log = (texts: string[]) => {
      if (texts.length === 0) return;
      const added = texts.map((text) => ({ id: (logged += 1), text })).reverse();
      setEvents((shown) => [...added, ...shown]);
    };
    live.current = {
      state: initialSeatState(seated.seat),
      socket: null,
      log: (text) => log([text]),
    };

    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    channel?.addEventListener("message", (event: MessageEvent<{ seatToken?: unknown }>) => {
      if (event.data?.seatToken === seated.seatToken) replace();
    });

    const retry: Reconnector = reconnector(connect);
    connect();

    /** この座席は別のタブが指している。繋ぎ直すと、そちらの接続を追い出す。 */
    function replace() {
      if (replaced) return;
      replaced = true;
      retry.stop();
      live.current.socket?.close();
      setConnection({
        state: "replaced",
        text: "この対戦を別のタブで開いたので、ここでは止めました。読み込み直すと、こちらで続けられます。",
      });
    }

    /** 座席を離れる。これより先は繋ぎ直さない。 */
    function leave(text: string) {
      retry.stop();
      live.current.socket = null;
      setLeft(text);
    }

    function receive(message: ServerMessage) {
      if (message.t !== "pong") setAwaiting(false);
      // 準備の選びかけは画面の操作でも変わるので、状態は `live` の 1 か所に置く。
      const before = live.current.state;
      const current = seatReducer(before, message);
      live.current.state = current;
      setState(current);
      switch (message.t) {
        case "sync":
        case "delta": {
          const happened = message.t === "delta" ? message.events : [];
          const notices = describeEvents(happened, [current.view, before.view], who, cardTable());
          log(eventLines(happened, notices));
          // 対戦が始まったあとに開いた画面では、先攻はもう済んだ話なので出さない。
          if (message.t === "sync" && !firstPlayerShown && message.view.phase === "setup") {
            firstPlayerShown = true;
            show({
              text:
                message.firstPlayer === seated.seat
                  ? "コイントスの結果、あなたが先攻です"
                  : "コイントスの結果、相手が先攻です（あなたは後攻）",
              coins: { results: [message.firstPlayer === seated.seat], faces: ["先攻", "後攻"] },
            });
          }
          for (const notice of notices) if (notice !== null && !notice.repeated) show(notice);
          return;
        }
        case "ended": {
          // 終わった座席へは繋ぎ直せない。覚えたままだと、次に開いたときに繋ぎに行って断られる。
          forgetSeat(seated.seatToken);
          const text = seatEndText(message, seated.seat);
          log([text]);
          show({ text, tone: seatEndTone(message.matchResult.winner, seated.seat) });
          void refreshRating();
          void checkShuffle(seated, message).then(([result, shown]) => {
            if (!disposed) setShuffle({ result, text: shown });
          });
          return;
        }
        case "reject": {
          // 古い画面から押したときは、サーバが正しい局面を送り直してくる。
          const text = rejectText(message.reason);
          log([text]);
          show({ text, tone: "attention" });
          return;
        }
        case "error":
          log([message.message]);
          show({ text: message.message, tone: "attention" });
          return;
        default:
          return;
      }
    }

    function connect() {
      const query = [`seatToken=${encodeURIComponent(seated.seatToken)}`];
      // 繋ぎ直しでも付ける。シェアを開く前に切れていれば、ここで開くことになる。
      if (typeof seated.seedShare === "string") {
        query.push(`seedShare=${encodeURIComponent(seated.seedShare)}`);
      }
      const ws = new WebSocket(socketUrl(query.join("&")));
      live.current.socket = ws;
      let code: string | null = null;
      let lost = false;
      /** この接続で `sync` か `pending` を受けたか。 */
      let joined = false;
      keepAlive(ws, onLost);
      ws.addEventListener("message", (event: MessageEvent<string>) => {
        if (lost || disposed || replaced) return;
        const message = JSON.parse(event.data) as ServerMessage;
        if ((message.t === "sync" || message.t === "pending") && !joined) {
          joined = true;
          known = true;
          retry.connected();
          setConnection(null);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- window ではなく BroadcastChannel なので宛先の origin を取らない。
          channel?.postMessage({ seatToken: seated.seatToken });
        }
        if (message.t === "ended") ended = true;
        if (message.t === "error" && typeof message.code === "string") code = message.code;
        receive(message);
      });
      ws.addEventListener("close", onLost);

      function onLost() {
        if (lost || disposed || replaced) return;
        lost = true;
        setAwaiting(false);
        if (ended) {
          retry.stop();
          return;
        }
        /**
         * 座席を捨てるのは、サーバが「この座席を知らない」と言ったときだけにする（仕様 3.3 節）。
         * 何も届かずに閉じた接続は、回線が切れただけのこともある。
         */
        if (code === "seat-not-found") {
          forgetSeat(seated.seatToken);
          leave("指していた対戦は、もう終わっています。");
          return;
        }
        if (code === "seat-replaced") {
          replace();
          return;
        }
        if (!known) {
          // 盤面の画面に留めると、繋がらない状態が続いたときに対戦を始める画面へ出られない。
          leave("サーバへ繋がりませんでした。読み込み直すと、指していた対戦へ繋ぎ直します。");
          return;
        }
        const attempt = retry.schedule();
        setConnection({
          state: "reconnecting",
          text: `接続が切れました。繋ぎ直しています（${attempt} 回目）`,
        });
      }
    }

    return () => {
      disposed = true;
      retry.stop();
      channel?.close();
      live.current.socket?.close();
    };
  }, [seated]);

  // サーバは、処理の途中で投げた手には何も返さず、接続は保つ。返事だけを待つと、ボタンが戻らない。
  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(() => setAwaiting(false), REPLY_WAIT_MS);
    return () => clearTimeout(timer);
  }, [awaiting]);

  const send = useCallback(
    (message: ClientMessage) => {
      const { socket, log } = live.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
        if (message.t === "move" || message.t === "setup") setAwaiting(true);
        return;
      }
      // 押してから確かめるまでのあいだに切れることがある。黙って捨てると、送れたと思われる。
      // できごとの欄は畳んであるので、そこに書くだけでは目に入らない。
      const text = "接続が切れているので送れませんでした。繋がってから、もう一度押してください。";
      log(text);
      notify({ text, tone: "attention" });
    },
    [notify],
  );

  const choose = useCallback((action: SetupAction) => {
    const next = seatReducer(live.current.state, action);
    live.current.state = next;
    setState(next);
  }, []);

  return { state, connection, events, shuffle, left, awaiting, send, choose };
}
