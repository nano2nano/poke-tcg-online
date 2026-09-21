/**
 * 相手を見つける（`docs/spec/battle-server.md` 7 節）。
 *
 * 合言葉と、待ち行列 1 本だけを持つ。レーティングで帯を分けない。
 * 人が少ないうちは待ち時間が伸びるだけである。
 *
 * 待ち合わせは要求と応答で足りるので HTTP に載せる。押し出しが要るのは
 * 対戦が始まってからで、そこから先が WebSocket である（3.1 節）。
 */

import { randomUUID } from "node:crypto";
import type { DeckList, Player } from "./engine.js";
import { describeViolation, validateDeck } from "./deck.js";
import { createMatch, type SeatInfo } from "./match.js";
import { MatchRegistry, newToken } from "./registry.js";
import type { AccountStore } from "./accounts.js";

export interface JoinRequest {
  /** 打ち手の合言葉（7.2 節）。これが無い対戦は始めない。 */
  secret: string;
  deck: DeckList;
  /** 名乗り直すとき。省けば登録済みの表示名を使う。 */
  displayName?: string;
  /** 同じ文字列を入れた 2 人を繋ぐ。無ければ待ち行列へ入る。 */
  roomCode?: string;
}

export interface Ticket {
  ticket: string;
  seat: SeatInfo;
  deck: DeckList;
  roomCode: string | null;
}

export type JoinOutcome =
  | { ok: false; errors: string[] }
  | { ok: true; ticket: string }
  | { ok: true; ticket: string; seat: Seated };

export interface Seated {
  matchId: string;
  seat: Player;
  seatToken: string;
}

export class Lobby {
  /** 待っている人。合言葉ごとに 1 人ずつと、合言葉なしの行列。 */
  private readonly waitingByRoom = new Map<string, Ticket>();
  private readonly queue: Ticket[] = [];
  /** 相手が見つかった人の引き取り口。本人が取りに来るまで置く。 */
  private readonly seated = new Map<string, Seated>();

  constructor(
    private readonly registry: MatchRegistry,
    private readonly accounts: AccountStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  join(request: JoinRequest): JoinOutcome {
    const nowMs = this.now();
    // 合言葉を先に見る。デッキの検査を通しても、誰の対戦か決まらなければ始められない。
    const account =
      request.displayName === undefined
        ? this.accounts.touch(request.secret, nowMs)
        : this.accounts.rename(request.secret, request.displayName, nowMs);
    if (account === null) return { ok: false, errors: ["打ち手が見つからない"] };

    const violations = validateDeck(request.deck);
    if (violations.length > 0) {
      return { ok: false, errors: violations.map(describeViolation) };
    }

    const ticket: Ticket = {
      ticket: newToken(),
      // 持ち点はこの時点の値で固める。対戦中に別の対戦が終わっても、この記録は動かない。
      seat: {
        playerId: account.playerId,
        displayName: account.displayName,
        rating: account.rating,
      },
      deck: request.deck,
      roomCode: request.roomCode ?? null,
    };

    const waiting = this.takeWaiting(ticket);
    if (waiting === null) {
      this.putWaiting(ticket);
      return { ok: true, ticket: ticket.ticket };
    }

    // 先に待っていたほうを座席 0 に据える。先攻は seed が決めるので、この順は有利不利を生まない。
    const seats = this.start(waiting, ticket);
    this.seated.set(waiting.ticket, seats[0]);
    return { ok: true, ticket: ticket.ticket, seat: seats[1] };
  }

  /** 待っている人が相手を見つけたかどうかを取りに来る口。 */
  claim(ticketId: string): Seated | null {
    const seat = this.seated.get(ticketId);
    if (seat === undefined) return null;
    this.seated.delete(ticketId);
    return seat;
  }

  /** 待つのをやめる。 */
  leave(ticketId: string): void {
    for (const [room, waiting] of this.waitingByRoom) {
      if (waiting.ticket === ticketId) this.waitingByRoom.delete(room);
    }
    const index = this.queue.findIndex((waiting) => waiting.ticket === ticketId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  waitingCount(): number {
    return this.queue.length + this.waitingByRoom.size;
  }

  private takeWaiting(ticket: Ticket): Ticket | null {
    if (ticket.roomCode !== null) {
      const waiting = this.waitingByRoom.get(ticket.roomCode);
      if (waiting === undefined) return null;
      this.waitingByRoom.delete(ticket.roomCode);
      return waiting;
    }
    return this.queue.shift() ?? null;
  }

  private putWaiting(ticket: Ticket): void {
    if (ticket.roomCode !== null) this.waitingByRoom.set(ticket.roomCode, ticket);
    else this.queue.push(ticket);
  }

  private start(first: Ticket, second: Ticket): [Seated, Seated] {
    const nowMs = this.now();
    const seatTokens: [string, string] = [newToken(), newToken()];
    const seats: [SeatInfo, SeatInfo] = [first.seat, second.seat];
    const match = createMatch({
      matchId: randomUUID(),
      decks: [first.deck, second.deck],
      seats,
      seatTokens,
      nowMs,
      startedAt: new Date(nowMs).toISOString(),
    });
    this.registry.add(match);
    return [
      { matchId: match.matchId, seat: 0, seatToken: seatTokens[0] },
      { matchId: match.matchId, seat: 1, seatToken: seatTokens[1] },
    ];
  }
}
