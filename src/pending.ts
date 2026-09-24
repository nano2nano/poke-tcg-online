/**
 * 座席のシェアが開くのを待っている対戦（`docs/spec/battle-server.md` 6.4 節）。
 *
 * 座席トークンとサーバのコミットはもう配ってあるが、`seed` はまだ決まっていない。
 * シェアを開くのは、サーバのコミットと相手のシェアのコミットを受け取ったあとである。
 * その順でないと、先に値を知った側が相手に合わせて自分の値を選べる。
 */

import type { DeckList, Player } from "./engine.js";
import {
  commitSeed,
  commitShare,
  SEED_SHARE_PATTERN,
  type SeedCommitment,
  type SeedShares,
} from "./fingerprint.js";
import { createMatch, type BotSeat, type Match, type SeatInfo } from "./match.js";

/**
 * シェアを開くのを待つ長さ。過ぎたら、開かなかった座席のシェアを null として対戦を始める。
 *
 * 待ち続けないのは、来ない相手を待つ人が対戦を始められなくなるからである。
 * 引き換えの問い合わせ間隔（7 節）の何倍もあれば、席に着く気のある人は間に合う。
 */
export const SHARE_REVEAL_DEADLINE_MS = 30_000;

export interface PendingMatch {
  readonly matchId: string;
  readonly decks: [DeckList, DeckList];
  readonly seats: [SeatInfo, SeatInfo];
  readonly seatTokens: [string, string];
  readonly spectatorToken: string;
  /** 席が決まった時刻。記録に残すレーティングを読んだのもこの時点である。 */
  readonly startedAt: string;
  /** シェアを混ぜる前の組。使うのは `nonce` と `commit` だけで、`seed` はまだ意味を持たない。 */
  readonly server: SeedCommitment;
  readonly shareCommits: SeedShares;
  readonly shares: SeedShares;
  readonly deadlineMs: number;
  /** AI の座席（7.3 節）。AI はシェアを出さないので、その座席のコミットは null である。 */
  readonly bot: BotSeat | null;
}

export type RevealOutcome = "accepted" | "ignored" | "mismatch";

/**
 * シェアを受け取る。コミットと合わないものは受け取らない。コミットに合う値は 1 つしか無いので、
 * 繋ぎ直して同じ値をもう一度開いても変わらない。
 */
export function reveal(pending: PendingMatch, seat: Player, share: string | null): RevealOutcome {
  const commit = pending.shareCommits[seat];
  if (share === null || commit === null) return "ignored";
  if (!SEED_SHARE_PATTERN.test(share) || commitShare(share) !== commit) return "mismatch";
  pending.shares[seat] = share;
  return "accepted";
}

export function allRevealed(pending: PendingMatch): boolean {
  return ([0, 1] as Player[]).every(
    (seat) => pending.shareCommits[seat] === null || pending.shares[seat] !== null,
  );
}

/** 開かなかった座席のシェアは null のまま混ぜる。時計はここから流れる。 */
export function startPending(pending: PendingMatch, nowMs: number): Match {
  return createMatch({
    matchId: pending.matchId,
    decks: pending.decks,
    seats: pending.seats,
    seatTokens: pending.seatTokens,
    spectatorToken: pending.spectatorToken,
    nowMs,
    startedAt: pending.startedAt,
    seedCommitment: commitSeed(pending.server.nonce, [...pending.shares]),
    seedShareCommits: pending.shareCommits,
    bot: pending.bot,
  });
}
