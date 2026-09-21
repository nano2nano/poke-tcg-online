/**
 * 生きている対戦の台帳。座席トークンから対戦と座席を引く（`docs/spec/battle-server.md` 3.3 節）。
 *
 * 索引が要る問い合わせはここにしか無く、すべてメモリにある（6.5 節）。
 * 終わった対戦はログへ落としてから台帳を離れる。
 */

import { randomBytes } from "node:crypto";
import type { Player } from "./engine.js";
import { applyTimeout, type Match } from "./match.js";
import { appendRecord, toRecord, type MatchRecord } from "./log.js";

export interface SeatRef {
  match: Match;
  seat: Player;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export class MatchRegistry {
  private readonly matches = new Map<string, Match>();
  private readonly seats = new Map<string, SeatRef>();

  constructor(private readonly logDir?: string) {}

  add(match: Match): void {
    this.matches.set(match.matchId, match);
    for (const seat of [0, 1] as Player[]) {
      this.seats.set(match.seatTokens[seat], { match, seat });
    }
  }

  bySeatToken(token: string): SeatRef | undefined {
    return this.seats.get(token);
  }

  live(): Match[] {
    return [...this.matches.values()];
  }

  /**
   * 終わった対戦をログへ落として台帳から外す。
   * すでに外れていれば何もしない（決着と切断が同じ対戦を二度連れてくる）。
   */
  retire(match: Match): MatchRecord | null {
    if (!this.matches.has(match.matchId)) return null;
    this.matches.delete(match.matchId);
    for (const token of match.seatTokens) this.seats.delete(token);
    const record = toRecord(match);
    appendRecord(record, this.logDir);
    return record;
  }

  /**
   * 持ち時間の尽きた対戦を終わらせる。終わった対戦を返す。
   * 切断中も時計は流れるので、この掃きは接続の生死を見ない（3.4 節）。
   */
  sweepTimeouts(nowMs: number): Match[] {
    return this.live().filter((match) => applyTimeout(match, nowMs));
  }
}
