/**
 * 座席と WebSocket の接続を束ねる（`docs/spec/battle-server.md` 3 節）。
 *
 * **時刻を読むのはこの層だけである。** 下の層（`match.ts`、`clock.ts`）は現在時刻を
 * 引数で受け取るので、時計の進みをテストで書ける。
 *
 * 座席へ出る値は `syncFor` / `deltaFor` が組み立てるものに限る。`match.ts` の
 * `viewFor` / `eventsFor` / `legalMovesFor` を通さない経路をここに作らない（1 節の S-2）。
 */

import type { DomainEvent, Player } from "./engine.js";
import {
  clockView,
  concede,
  engineOutcome,
  eventsFor,
  legalMovesFor,
  submitMove,
  toMove,
  viewFor,
  type Match,
} from "./match.js";
import type { ClientMessage, DeltaMessage, ServerMessage, SyncMessage } from "./protocol.js";
import type { MatchRegistry } from "./registry.js";
import type { MatchRecord } from "./log.js";

/** 送り先。`ws` の `WebSocket` はこの形を満たす。試験では素のオブジェクトを渡す。 */
export interface SeatSocket {
  send(data: string): void;
  close(): void;
}

export interface HubOptions {
  registry: MatchRegistry;
  now?: () => number;
  /** 対戦が終わってログへ落ちたあとに 1 度だけ呼ぶ。持ち点の更新がここに乗る。 */
  onFinish?: (record: MatchRecord) => void;
}

export class MatchHub {
  /** 対戦 ID → 座席 → 接続。1 座席に 1 本だけ持つ。 */
  private readonly sockets = new Map<string, Map<Player, SeatSocket>>();
  private readonly now: () => number;

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 座席トークンで座席に就く。再接続もこれ 1 つで、特別な復元の手順は要らない
   * （局面はサーバが持っている）。同じ座席に 2 本目が繋がったら古いほうを閉じる。
   */
  attach(socket: SeatSocket, seatToken: string): boolean {
    const ref = this.options.registry.bySeatToken(seatToken);
    if (ref === undefined) {
      send(socket, {
        t: "error",
        message: "座席が見つからない（対戦が終わっているか、合言葉が違う）",
      });
      return false;
    }
    const perMatch = this.sockets.get(ref.match.matchId) ?? new Map<Player, SeatSocket>();
    const previous = perMatch.get(ref.seat);
    if (previous !== undefined && previous !== socket) previous.close();
    perMatch.set(ref.seat, socket);
    this.sockets.set(ref.match.matchId, perMatch);
    send(socket, this.syncFor(ref.match, ref.seat));
    return true;
  }

  detach(socket: SeatSocket): void {
    for (const [matchId, perMatch] of this.sockets) {
      for (const [seat, held] of perMatch) {
        if (held === socket) perMatch.delete(seat);
      }
      if (perMatch.size === 0) this.sockets.delete(matchId);
    }
  }

  /** 1 通を処理する。`seatToken` は `attach` 済みのものを呼び出し側が持つ。 */
  handle(socket: SeatSocket, seatToken: string, message: ClientMessage): void {
    const ref = this.options.registry.bySeatToken(seatToken);
    if (ref === undefined) {
      send(socket, { t: "error", message: "座席が見つからない" });
      return;
    }
    const { match, seat } = ref;
    switch (message.t) {
      case "hello":
        send(socket, this.syncFor(match, seat));
        return;
      case "ping":
        send(socket, { t: "pong" });
        return;
      case "move": {
        const outcome = submitMove(
          match,
          seat,
          message.stateVersion,
          message.move,
          this.now(),
          message.offered ?? null,
        );
        if (!outcome.ok) {
          send(socket, { t: "reject", reason: outcome.reason, stateVersion: match.version });
          // 画面が古いことが理由なら、正しい局面を送り直す。
          if (outcome.reason === "stale-version") send(socket, this.syncFor(match, seat));
          return;
        }
        this.broadcastDelta(match, outcome.events);
        if (match.result !== null) this.endMatch(match);
        return;
      }
      case "concede":
        if (concede(match, seat, this.now())) this.endMatch(match);
        return;
    }
  }

  /** 決着を両座席へ伝え、ログへ落として台帳から外す。 */
  endMatch(match: Match): void {
    const perMatch = this.sockets.get(match.matchId);
    for (const seat of [0, 1] as Player[]) {
      const socket = perMatch?.get(seat);
      if (socket === undefined) continue;
      if (match.result === null) continue;
      send(socket, {
        t: "ended",
        matchResult: match.result,
        outcome: engineOutcome(match),
        seed: match.seedCommitment.seed,
        seedNonce: match.seedCommitment.nonce,
        view: viewFor(match, seat),
      });
    }
    this.sockets.delete(match.matchId);
    // `retire` は同じ対戦を二度落とさないので、`onFinish` も 1 局につき 1 度である。
    const record = this.options.registry.retire(match);
    if (record !== null) this.options.onFinish?.(record);
  }

  /** 持ち時間の尽きた対戦を終わらせる。呼ぶのは起動側の定期処理である。 */
  sweepTimeouts(): void {
    for (const match of this.options.registry.sweepTimeouts(this.now())) this.endMatch(match);
  }

  private broadcastDelta(match: Match, events: DomainEvent[]): void {
    const perMatch = this.sockets.get(match.matchId);
    if (perMatch === undefined) return;
    for (const seat of [0, 1] as Player[]) {
      const socket = perMatch.get(seat);
      if (socket !== undefined) send(socket, this.deltaFor(match, seat, events));
    }
  }

  private syncFor(match: Match, seat: Player): SyncMessage {
    return {
      t: "sync",
      matchId: match.matchId,
      seat,
      stateVersion: match.version,
      view: viewFor(match, seat),
      legalMoves: legalMovesFor(match, seat),
      clock: clockView(match, this.now()),
      seedCommit: match.seedCommitment.commit,
    };
  }

  private deltaFor(match: Match, seat: Player, events: DomainEvent[]): DeltaMessage {
    return {
      t: "delta",
      stateVersion: match.version,
      events: eventsFor(events, seat),
      view: viewFor(match, seat),
      legalMoves: legalMovesFor(match, seat),
      clock: clockView(match, this.now()),
    };
  }
}

/** 手番側かどうか。試験と配信層が同じ判定を使う。 */
export function isToMove(match: Match, seat: Player): boolean {
  return toMove(match) === seat;
}

function send(socket: SeatSocket, message: ServerMessage): void {
  socket.send(JSON.stringify(message));
}
