/**
 * 始まる前の対戦（`docs/spec/battle-server.md` 2.5 節、6.4 節）。
 *
 * 座席トークンとサーバのコミットはもう配ってあるが、座席のシェアが開くまで `seed` は決まらない。
 * シェアを開くのは、サーバのコミットと相手のシェアのコミットを受け取ったあとである。
 * その順でないと、先に値を知った側が相手に合わせて自分の値を選べる。
 *
 * `seed` が決まったらコイントスをし、勝った座席が先攻か後攻かを選ぶまで待つ。
 * 公式の手順でも、先攻と後攻は山札を切って手札を引くより前に決める。
 */

import { opponent, type DeckList, type Player } from "./engine.js";
import {
  commitSeed,
  commitShare,
  SEED_SHARE_PATTERN,
  type SeedCommitment,
  type SeedShares,
} from "./fingerprint.js";
import { consume, createClock, moveRemainingMs } from "./clock.js";
import { createMatch, tossWinner, type BotSeats, type Match, type SeatInfo } from "./match.js";

/**
 * シェアを開くのを待つ長さ。過ぎたら、開かなかった座席のシェアを null として対戦を始める。
 *
 * 待ち続けないのは、来ない相手を待つ人が対戦を始められなくなるからである。
 * 引き換えの問い合わせ間隔（7 節）の何倍もあれば、席に着く気のある人は間に合う。
 */
export const SHARE_REVEAL_DEADLINE_MS = 30_000;

export interface Toss {
  /** シェアを混ぜたあとの組。これより後に届いたシェアは混ぜない。 */
  seedCommitment: SeedCommitment;
  winner: Player;
  /** 勝った座席が選び始めた時刻。選ぶのに使った時間は、その座席の持ち時間から引く。 */
  atMs: number;
}

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
  /** シェアを開く期限。コイントスのあとは、先攻か後攻かを選ぶ期限になる。 */
  deadlineMs: number;
  /** シェアがそろうまで null。 */
  toss: Toss | null;
  /** 座席ごとの AI（7.3 節）。AI はシェアを出さないので、その座席のコミットは null である。 */
  readonly bots: BotSeats;
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

/**
 * `seed` を決めてコイントスをする。開かなかった座席のシェアは null のまま混ぜる。
 * 選ぶ期限は、勝った座席の持ち時間が尽きるまでである。
 */
export function tossCoin(pending: PendingMatch, nowMs: number): void {
  const seedCommitment = commitSeed(pending.server.nonce, [...pending.shares]);
  const winner = tossWinner(seedCommitment.seed, pending.decks);
  pending.toss = { seedCommitment, winner, atMs: nowMs };
  pending.deadlineMs = nowMs + moveRemainingMs(createClock(), 0);
}

/**
 * 勝った座席が AI なら、AI が選んだ先攻。人なら null で、人が選ぶのを待つ。
 * 方策は対戦が始まってからの局面でしか手を選べないので、AI は決め打ちで後攻を選ぶ（7.3 節）。
 */
export function botTurnOrder({ toss, bots }: PendingMatch): Player | null {
  if (toss === null || bots[toss.winner] === null) return null;
  return opponent(toss.winner);
}

/** 先攻を決めて始める。勝った座席が選ぶのに使った時間は、ふだんの 1 手と同じく持ち時間から引く。 */
export function startPending(pending: PendingMatch, nowMs: number, firstPlayer: Player): Match {
  const { toss } = pending;
  if (toss === null) throw new Error(`コイントスの前に始めようとした: ${pending.matchId}`);
  const match = createMatch({
    matchId: pending.matchId,
    decks: pending.decks,
    seats: pending.seats,
    seatTokens: pending.seatTokens,
    spectatorToken: pending.spectatorToken,
    nowMs,
    startedAt: pending.startedAt,
    seedCommitment: toss.seedCommitment,
    seedShareCommits: pending.shareCommits,
    bots: pending.bots,
    firstPlayer,
  });
  match.clocks[toss.winner] = consume(match.clocks[toss.winner], nowMs - toss.atMs);
  return match;
}
