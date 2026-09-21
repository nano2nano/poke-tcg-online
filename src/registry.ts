/**
 * 生きている対戦のレジストリ。座席トークンから対戦と座席を引く（`docs/spec/battle-server.md` 3.3 節）。
 *
 * 索引が要る問い合わせはここにしか無く、すべてメモリにある（6.5 節）。
 * 終わった対戦はログへ落としてからレジストリを離れる。
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
   * 終わった対戦をログへ落としてレジストリから外す。
   * すでに外れていれば何もしない（決着と切断が同じ対戦を二度連れてくる）。
   *
   * **返すのは、ログへ落ちた対戦だけである。** 書けなかったときは `null` を返す。
   * 呼び手はこれを見て、記録に残らなかった対戦でレーティングを動かさずに済む（7.2 節）。
   */
  retire(match: Match): MatchRecord | null {
    if (!this.matches.has(match.matchId)) return null;
    this.matches.delete(match.matchId);
    for (const token of match.seatTokens) this.seats.delete(token);
    const record = toRecord(match);
    try {
      appendRecord(record, this.logDir);
    } catch (error) {
      /**
       * **落ちても投げ返さない。** ここは持ち時間のスイープと WebSocket の処理から呼ばれる。
       * 投げると走っているもの全体が止まり、同じスイープで終わらせるはずだった別の対戦も残る。
       * 記録は失われるが、それは投げても同じで、投げるとさらに失う。大きく残す。
       *
       * **そして `null` を返す。** レーティングは対局ログから作り直せる、というのが 7.2 節である。
       * 書けなかった対戦でレーティングだけ動かすと、その関係が切れる。一覧にも出ない対戦のぶん
       * レーティングが動いていて、どこから来た差か誰にも言えなくなる。動かさないほうが直せる。
       */
      console.error(`対局ログを書けなかった（${match.matchId}）。レーティングは動かさない:`, error);
      return null;
    }
    return record;
  }

  /**
   * 持ち時間の尽きた対戦を終わらせる。終わった対戦を返す。
   * 切断中も時計は流れるので、このスイープは接続の生死を見ない（3.4 節）。
   */
  sweepTimeouts(nowMs: number): Match[] {
    return this.live().filter((match) => applyTimeout(match, nowMs));
  }
}
