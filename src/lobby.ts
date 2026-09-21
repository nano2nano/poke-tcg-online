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

/**
 * 待っている札の行方。
 *
 * `dropped` が要るのは、**札が黙って消えることがある**からである。同じ打ち手が
 * 別の窓から入ると古い札は降りる。それを `waiting` と同じ応答にすると、
 * 古い窓は「相手を待っています」のまま永久に問い合わせ続ける。
 *
 * `finished` が別に要るのは、**席が決まったあとに終わった対戦がある**からである。
 * 取りに行く前に相手が投了するか時間切れになると、席そのものはもう無い。
 * これを `dropped` と同じにすると「別の窓から入り直した」と嘘を出すことになる。
 * その人は指していないが打ち手としては数えられていて、持ち点も動き、記録も残っている。
 */
export type ClaimOutcome =
  | { kind: "waiting" }
  | { kind: "seated"; seat: Seated }
  | { kind: "finished"; matchId: string }
  | { kind: "dropped" };

/**
 * 引き取り口をいくつ覚えておくか。取りに来るのは 1 秒ごとなので、待っている人の数を
 * 大きく超えていれば足りる。溢れたぶんは `dropped` に見えるが、それは元の作りと同じである。
 */
const SEATED_LIMIT = 256;

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
    // ここでは読むだけで、置き場は書き換えない。
    const known = this.accounts.bySecret(request.secret);
    if (known === null) return { ok: false, errors: ["打ち手が見つからない"] };

    const violations = validateDeck(request.deck);
    if (violations.length > 0) {
      return { ok: false, errors: violations.map(describeViolation) };
    }

    /**
     * **置き場を書き換えるのは、入れると決まってからである。** 先に書くと、デッキで
     * 断られた人の名乗りだけが変わって残る。断られた側から見れば何も起きていないのに、
     * 置き場でもそれ以後の対局ログでも名前が変わっている。
     */
    const account =
      (request.displayName === undefined
        ? this.accounts.touch(request.secret, nowMs)
        : this.accounts.rename(request.secret, request.displayName, nowMs)) ?? known;

    const ticket: Ticket = {
      ticket: newToken(),
      // ここの持ち点は仮である。記録に残すのは**対戦が始まった時点**の値で、`start` が読み直す。
      seat: {
        playerId: account.playerId,
        displayName: account.displayName,
        rating: account.rating,
      },
      deck: request.deck,
      roomCode: request.roomCode ?? null,
    };

    /**
     * **同じ打ち手は 1 つしか待たせない。** 別の窓を開いたり、待っている間に読み込み直すと、
     * 同じ `playerId` が両側に座りうる。自分と自分の対戦が 1 局として記録に残り、
     * その打ち手に 1 勝 1 敗が付く。古いほうを降ろせば、自分に当たること自体が起きない。
     */
    this.dropWaiting(account.playerId);

    const waiting = this.takeWaiting(ticket);
    if (waiting === null) {
      this.putWaiting(ticket);
      return { ok: true, ticket: ticket.ticket };
    }

    // 先に待っていたほうを座席 0 に据える。先攻は seed が決めるので、この順は有利不利を生まない。
    const seats = this.start(waiting, ticket);
    this.rememberSeated(waiting.ticket, seats[0]);
    return { ok: true, ticket: ticket.ticket, seat: seats[1] };
  }

  /**
   * 待っている人が相手を見つけたかどうかを取りに来る口。
   *
   * **取りに来ても消さない。** 1 度読んだら消す作りだと、その応答が回線の不調で
   * 落ちたときに、次に取りに来た人へ「もう降りている」と答えることになる。
   * 対戦のほうは始まっているので、その人は座らないまま時間切れで負ける。
   * 札そのものが引き取りの合鍵なので、同じ札で何度取りに来ても同じ座席を返す。
   */
  claim(ticketId: string): ClaimOutcome {
    const seat = this.seated.get(ticketId);
    if (seat !== undefined) {
      /**
       * **終わった対戦と、降りた札は別である。** 取りに行く前に相手が投了するか
       * 時間切れになると席はもう無いが、それは「別の窓から入り直した」ではない。
       * 対戦はあったことにして、そう答える。生きているかどうかは台帳が知っている。
       */
      if (this.registry.bySeatToken(seat.seatToken) === undefined) {
        return { kind: "finished", matchId: seat.matchId };
      }
      return { kind: "seated", seat };
    }
    return this.isWaiting(ticketId) ? { kind: "waiting" } : { kind: "dropped" };
  }

  /**
   * 引き取り口を覚える。消さなくなったぶん、入った順に古いものを捨てて溜まりを止める。
   * 終わった対戦のぶんも、取りに来た人へ「もう終わっている」と答えるために残す。
   */
  private rememberSeated(ticketId: string, seat: Seated): void {
    this.seated.set(ticketId, seat);
    while (this.seated.size > SEATED_LIMIT) {
      const oldest = this.seated.keys().next().value;
      if (oldest === undefined) break;
      this.seated.delete(oldest);
    }
  }

  private isWaiting(ticketId: string): boolean {
    for (const waiting of this.waitingByRoom.values()) {
      if (waiting.ticket === ticketId) return true;
    }
    return this.queue.some((waiting) => waiting.ticket === ticketId);
  }

  /** その打ち手が待っているものを、どこにいても降ろす。 */
  private dropWaiting(playerId: string): void {
    for (const [room, waiting] of this.waitingByRoom) {
      if (waiting.seat.playerId === playerId) this.waitingByRoom.delete(room);
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      if (this.queue[index]?.seat.playerId === playerId) this.queue.splice(index, 1);
    }
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

  /** 札の座席を、今の持ち点と名乗りで取り直す。打ち手が消えていれば札のままを使う。 */
  private seatNow(ticket: Ticket): SeatInfo {
    const account = this.accounts.byPlayerId(ticket.seat.playerId);
    if (account === null) return ticket.seat;
    return {
      playerId: account.playerId,
      displayName: account.displayName,
      rating: account.rating,
    };
  }

  private putWaiting(ticket: Ticket): void {
    if (ticket.roomCode !== null) this.waitingByRoom.set(ticket.roomCode, ticket);
    else this.queue.push(ticket);
  }

  private start(first: Ticket, second: Ticket): [Seated, Seated] {
    const nowMs = this.now();
    const seatTokens: [string, string] = [newToken(), newToken()];
    /**
     * **持ち点は今この場で読み直す**（7.2 節）。待っている間に別の窓の対戦が終われば
     * 持ち点は動いている。札を取ったときの値を残すと、記録が「対戦を始めた時点」でなくなる。
     */
    const seats: [SeatInfo, SeatInfo] = [this.seatNow(first), this.seatNow(second)];
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
