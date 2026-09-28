/**
 * 生きている対戦のレジストリ。座席トークンから対戦と座席を、観戦トークンから対戦を引く
 * （`docs/spec/battle-server.md` 3.3 節、3.6 節）。
 *
 * 生きている対戦はメモリにしか無い。終わった対戦は記録に直してレジストリを離れ、
 * 残すのは呼び手である（`src/archive.ts`）。
 */

import { randomBytes } from "node:crypto";
import type { Player } from "./engine.js";
import { applyTimeout, type Match, type SeatInfo } from "./match.js";
import { toRecord, type MatchRecord } from "./log.js";
import { startPending, type PendingMatch } from "./pending.js";
import type { SeedShares } from "./fingerprint.js";

export interface SeatRef {
  match: Match;
  seat: Player;
}

export interface PendingSeatRef {
  pending: PendingMatch;
  seat: Player;
}

/** 続いている対戦の、そのプレイヤーの座席。ロビーが席を渡すときの形（`Seated`）と同じ欄を持つ。 */
export interface LiveSeat {
  matchId: string;
  seat: Player;
  seatToken: string;
  seedCommit: string;
  seedShareCommits: SeedShares;
  /** 相手が AI の対戦か。断るときの `code` を分けるためだけに持つ。 */
  bot: boolean;
}

/** 同じプレイヤーが両側に座ることは無い（7.1 節）ので、どちらか一方を返せばよい。 */
function seatOf(seats: readonly [SeatInfo, SeatInfo], playerId: string): Player | null {
  if (seats[0].playerId === playerId) return 0;
  if (seats[1].playerId === playerId) return 1;
  return null;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export class MatchRegistry {
  private readonly matches = new Map<string, Match>();
  private readonly seats = new Map<string, SeatRef>();
  private readonly spectators = new Map<string, Match>();
  private readonly pending = new Map<string, PendingMatch>();
  private readonly pendingSeats = new Map<string, PendingSeatRef>();

  add(match: Match): void {
    this.matches.set(match.matchId, match);
    for (const seat of [0, 1] as Player[]) {
      this.seats.set(match.seatTokens[seat], { match, seat });
    }
    this.spectators.set(match.spectatorToken, match);
  }

  bySeatToken(token: string): SeatRef | undefined {
    return this.seats.get(token);
  }

  addPending(pending: PendingMatch): void {
    this.pending.set(pending.matchId, pending);
    for (const seat of [0, 1] as Player[]) {
      this.pendingSeats.set(pending.seatTokens[seat], { pending, seat });
    }
  }

  pendingBySeatToken(token: string): PendingSeatRef | undefined {
    return this.pendingSeats.get(token);
  }

  holdsSeat(token: string): boolean {
    return this.seats.has(token) || this.pendingSeats.has(token);
  }

  /** 座席トークンは、始まる前と同じものがそのまま使える。 */
  start(pending: PendingMatch, nowMs: number): Match {
    const match = startPending(pending, nowMs);
    this.dropPending(pending);
    this.add(match);
    return match;
  }

  dropPending(pending: PendingMatch): void {
    this.pending.delete(pending.matchId);
    for (const token of pending.seatTokens) this.pendingSeats.delete(token);
  }

  overdue(nowMs: number): PendingMatch[] {
    return [...this.pending.values()].filter((pending) => pending.deadlineMs <= nowMs);
  }

  /**
   * そのプレイヤーが座っている、終わっていない対戦（7.1 節、7.3 節）。始まる前のものも含む。
   * 返すのは座席で、その人が画面を失っていても、ここから対戦へ戻れる。
   *
   * 決着の付いた対戦は数えない。決着のあとの後始末で投げるとレジストリに残ることがあり、
   * 数えると、その人は二度と対戦に入れなくなる。
   */
  liveSeatOf(playerId: string): LiveSeat | null {
    for (const match of this.matches.values()) {
      if (match.result !== null) continue;
      const seat = seatOf(match.seats, playerId);
      if (seat === null) continue;
      return {
        matchId: match.matchId,
        seat,
        seatToken: match.seatTokens[seat],
        seedCommit: match.seedCommitment.commit,
        seedShareCommits: match.seedShareCommits,
        bot: match.bots.some((bot) => bot !== null),
      };
    }
    for (const pending of this.pending.values()) {
      const seat = seatOf(pending.seats, playerId);
      if (seat === null) continue;
      return {
        matchId: pending.matchId,
        seat,
        seatToken: pending.seatTokens[seat],
        seedCommit: pending.server.commit,
        seedShareCommits: pending.shareCommits,
        bot: pending.bots.some((bot) => bot !== null),
      };
    }
    return null;
  }

  bySpectatorToken(token: string): Match | undefined {
    return this.spectators.get(token);
  }

  live(): Match[] {
    return [...this.matches.values()];
  }

  liveCount(): number {
    return this.matches.size + this.pending.size;
  }

  /** 時計の流れているものが 1 つも無い。始める前の対戦も、来ない座席の時計が流れる。 */
  idle(): boolean {
    return this.liveCount() === 0;
  }

  /**
   * 終わった対戦をレジストリから外し、記録に直して返す。
   * すでに外れていれば null を返す（決着と切断が同じ対戦を二度連れてくる）。
   */
  retire(match: Match): MatchRecord | null {
    if (!this.matches.has(match.matchId)) return null;
    this.matches.delete(match.matchId);
    for (const token of match.seatTokens) this.seats.delete(token);
    this.spectators.delete(match.spectatorToken);
    return toRecord(match);
  }

  /**
   * 持ち時間の尽きた対戦を終わらせる。終わった対戦を返す。
   * 切断中も時計は流れるので、このスイープは接続の生死を見ない（3.4 節）。
   */
  sweepTimeouts(nowMs: number): Match[] {
    return this.live().filter((match) => applyTimeout(match, nowMs));
  }
}
