/** 対戦サーバへの WebSocket を開き、生かしておき、切れたら繋ぎ直す。 */

export function socketUrl(query: string): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws?${query}`;
}

/**
 * 開いている間、間を空けて `ping` を送る。サーバはしばらく何も届かない接続を切る（仕様 3.5 節）。
 * Cloudflare Workers にはサーバから ping を送る手段が無いので、生きていることは画面の側から伝える。
 *
 * 開いてから、または `ping` を送ってから、次に送るときまでに何も届かなければ、接続を閉じて
 * `onSilent` を呼ぶ（同じ節）。線が途中で切れると `close` はいつまでも来ず、繋ぎ直しが始まらない。
 */
export function keepAlive(ws: WebSocket, onSilent: () => void): void {
  let answered = false;
  ws.addEventListener("message", () => {
    answered = true;
  });
  const timer = setInterval(() => {
    if (!answered) {
      clearInterval(timer);
      ws.close();
      onSilent();
      return;
    }
    answered = false;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" }));
  }, 20_000);
  ws.addEventListener("close", () => clearInterval(timer));
}

export interface Reconnector {
  /** 次に繋ぐのを予約し、何回目の繋ぎ直しかを返す。 */
  schedule(): number;
  connected(): void;
  stop(): void;
}

/**
 * 間隔を倍々に延ばしながら繋ぎ直す。回線が戻ったと分かったら待たずに繋ぐ。
 * 間隔に揺らぎを混ぜ、サーバが戻った瞬間に全員が同時に繋ぎに来るのを避ける。
 */
export function reconnector(connect: () => void): Reconnector {
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connectedAt: number | null = null;
  const now = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    connect();
  };
  window.addEventListener("online", now);
  return {
    schedule() {
      // 繋がってすぐ切れる状態が続くときは、間隔を延ばし続ける。
      if (connectedAt !== null && Date.now() - connectedAt >= 30_000) retries = 0;
      connectedAt = null;
      const delay = Math.min(30_000, 1_000 * 2 ** retries) * (0.5 + Math.random() / 2);
      retries += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      return retries;
    },
    connected() {
      connectedAt = Date.now();
    },
    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener("online", now);
    },
  };
}
