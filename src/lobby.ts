/**
 * 相手を見つける（`docs/spec/battle-server.md` 7 節）。
 *
 * ルームコードと、マッチングキュー 1 本だけを持つ。レーティング帯で分けない。
 * 人が少ないうちは待ち時間が伸びるだけである。
 *
 * マッチングは要求と応答で足りるので HTTP に載せる。サーバからのプッシュが要るのは
 * 対戦が始まってからで、そこから先が WebSocket である（3.1 節）。
 */

import { randomUUID } from "node:crypto";
import type { DeckList, Player } from "./engine.js";
import { describeViolation, validateDeck } from "./deck.js";
import type { BotSeat, SeatInfo } from "./match.js";
import { MatchRegistry, newToken } from "./registry.js";
import { ACCOUNT_NOT_FOUND, type Account, type AccountStore } from "./accounts.js";
import { commitSeed, noShares, type SeedShares } from "./fingerprint.js";
import { allRevealed, SHARE_REVEAL_DEADLINE_MS, type PendingMatch } from "./pending.js";
import { BOT_PLAYER_PREFIX, type Bot } from "./bots.js";

export interface JoinRequest {
  /** プレイヤーのシークレット（7.2 節）。これが無い対戦は始めない。 */
  secret: string;
  deck: DeckList;
  /** 表示名を変えるとき。省けば登録済みの表示名を使う。 */
  displayName?: string;
  /** 同じ文字列を入れた 2 人を繋ぐ。無ければマッチングキューへ入る。 */
  roomCode?: string;
  /**
   * シャッフルへのシェアのコミット（6.4 節）。シェアそのものは、席に着いてから開く。
   * 省いた座席はシェアを出さず、その対戦の並びはサーバと相手の値で決まる。
   */
  seedShareCommit?: string;
}

/** 終わっていない AI との対戦があるので、次を始めない（7.3 節）。 */
export const BOT_MATCH_LIVE = "bot-match-live";

function accountMissing(): JoinOutcome {
  return { ok: false, code: ACCOUNT_NOT_FOUND, errors: ["アカウントが見つからない"] };
}

/** AI と対戦するときの要求（7.3 節）。相手を待たないので、ルームコードは無い。 */
export type BotJoinRequest = Omit<JoinRequest, "roomCode">;

export interface Ticket {
  ticket: string;
  seat: SeatInfo;
  deck: DeckList;
  roomCode: string | null;
  shareCommit: string | null;
}

export type JoinOutcome =
  /** `code` は画面が文言で分岐せずに済むようにする（§4）。無い断りはデッキの違反である。 */
  | { ok: false; errors: string[]; code?: string; seat?: Seated }
  | { ok: true; ticket: string }
  | { ok: true; ticket: string; seat: Seated };

export interface Seated {
  matchId: string;
  seat: Player;
  seatToken: string;
  /**
   * サーバのコミットと、両座席のシェアのコミット。シェアを開く前に受け取っておく。
   * 決着のあとに開かれた値をこれと突き合わせれば、どちらの値もあとから選び直されていないと分かる。
   */
  seedCommit: string;
  seedShareCommits: SeedShares;
}

/**
 * 待っているチケットの行方。
 *
 * `dropped` が要るのは、チケットが黙って消えることがあるからである。同じプレイヤーが
 * 別のタブから入ると古いチケットは降りる。それを `waiting` と同じ応答にすると、
 * 古いタブは「相手を待っています」のまま永久に問い合わせ続ける。
 *
 * `finished` が別に要るのは、**席が決まったあとに終わった対戦がある**からである。
 * 取りに行く前に相手が投了するか時間切れになると、席そのものはもう無い。
 * これを `dropped` と同じにすると「別のタブから入り直した」と嘘を出すことになる。
 * その人は指していないがプレイヤーとしては数えられていて、レーティングも動き、記録も残っている。
 *
 * `unknown` が別に要るのは、**知らないチケットと、降ろしたチケットは別である**からである。
 * ロビーはメモリにしか無いので、サーバを入れ替えればチケットは全部知らないものになる。
 * 覚えていられる数を超えたぶんも同じである。これを `dropped` と答えると、
 * タブを 1 つしか開いていない人に「別のタブから入り直した」と言うことになる。
 */
export type ClaimOutcome =
  | { kind: "waiting" }
  | { kind: "seated"; seat: Seated }
  | { kind: "finished"; matchId: string }
  | { kind: "dropped" }
  | { kind: "unknown" };

/**
 * 引き換え待ちの座席をいくつ覚えておくか。超えたぶんは、**終わった対戦の席から**捨てる。
 * 終わっていない席は残すので、同時に進んでいる対戦が多ければこの数を超えて持つ。
 */
const SEATED_LIMIT = 256;

/**
 * 降ろしたチケットをいくつ覚えておくか。降ろされたタブが次に取りに来るまで持てばよい。
 * 溢れたぶんは `unknown` になる。「知らない」は、いつでも本当のことである。
 */
const DROPPED_LIMIT = 256;

/**
 * 捨てた席の対戦の識別子をいくつ覚えておくか。持つのは 2 つの文字列だけなので、
 * 席より多く持てる。
 */
const FINISHED_LIMIT = 4_096;

export class Lobby {
  /** 待っている人。ルームコードごとに 1 人ずつと、ルームコードなしのキュー。 */
  private readonly waitingByRoom = new Map<string, Ticket>();
  /** こちらから降ろしたチケット。知らないチケットと区別するためだけに持つ。 */
  private readonly dropped = new Set<string>();
  /** 溢れて捨てた席の、対戦の識別子。席が無くなっても「もう終わっている」と答えるために持つ。 */
  private readonly finished = new Map<string, string>();
  private readonly queue: Ticket[] = [];
  /** マッチングが成立した人の座席。本人が引き換えに来るまで置く。 */
  private readonly seated = new Map<string, Seated>();
  /**
   * AI の重みを読んでいる途中のプレイヤー。読み込みは待つので、そのあいだに同じ人の要求が
   * いくつ来ても「続いている対戦」はまだ無い。これが無いと、1 人で読み込みの列に何本でも並べられ、
   * ほかの人の読み込みがそのぶん待たされる。
   */
  private readonly botJoining = new Set<string>();

  constructor(
    private readonly registry: MatchRegistry,
    private readonly accounts: AccountStore,
    private readonly now: () => number = () => Date.now(),
    /** 覚えておく席の数。テストが 256 局を作らずに済むように差し替えられる。 */
    private readonly seatedLimit: number = SEATED_LIMIT,
  ) {}

  /**
   * `known` は `request.secret` で引いたプレイヤーである。D1 を読むのは非同期で、ロビーは同期で
   * 動くので、呼び手が先に引いておく。
   */
  join(request: JoinRequest, known: Account | null): JoinOutcome {
    const nowMs = this.now();
    // シークレットを先に見る。デッキの検査を通しても、誰の対戦か決まらなければ始められない。
    if (known === null) {
      return { ok: false, code: ACCOUNT_NOT_FOUND, errors: ["アカウントが見つからない"] };
    }

    const violations = validateDeck(request.deck);
    if (violations.length > 0) {
      return { ok: false, errors: violations.map(describeViolation) };
    }

    /**
     * **ストアを書き換えるのは、入れると決まってからである。** 先に書くと、デッキで
     * 断られた人の表示名だけが変わって残る。断られた側から見れば何も起きていないのに、
     * ストアでもそれ以後の対局ログでも名前が変わっている。
     */
    const account =
      request.displayName === undefined
        ? this.accounts.touch(known, nowMs)
        : this.accounts.rename(known, request.displayName, nowMs);

    const ticket: Ticket = {
      ticket: newToken(),
      // ここのレーティングは仮である。記録に残すのは対戦が始まった時点の値で、`start` が読み直す。
      seat: {
        playerId: account.playerId,
        displayName: account.displayName,
        rating: account.rating,
      },
      deck: request.deck,
      roomCode: request.roomCode ?? null,
      shareCommit: request.seedShareCommit ?? null,
    };

    /**
     * **同じプレイヤーは 1 つしか待たせない。** 別のタブを開いたり、待っている間に読み込み直すと、
     * 同じ `playerId` が両側に座りうる。自分と自分の対戦が 1 局として記録に残り、
     * そのプレイヤーに 1 勝 1 敗が付く。古いほうを降ろせば、自分に当たること自体が起きない。
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
   * AI と対戦する（7.3 節）。相手を待たないので、その場で席が決まる。
   *
   * 人の座席の扱いは `join` と同じで、シークレットを先に見て、デッキを検査し、
   * 入ると決まってから表示名を書く。AI の座席はシェアを出さない。シャッフルの公正さを
   * 疑う理由があるのは人の側だけで、その人のシェアは `join` と同じく混ざる。
   */
  joinBot(
    request: BotJoinRequest,
    known: Account | null,
    bot: Bot,
    botDeck: DeckList,
  ): JoinOutcome {
    const refusal = this.refuseBot(request, known, botDeck);
    if (refusal !== null) return refusal;
    if (known === null) return accountMissing();
    const nowMs = this.now();
    const account =
      request.displayName === undefined
        ? this.accounts.touch(known, nowMs)
        : this.accounts.rename(known, request.displayName, nowMs);
    // 待っているものは降ろす。AI と指しているあいだに、キューで当たった人との対戦が始まらないようにする。
    this.dropWaiting(account.playerId);

    // レーティングはメモリから読み直す。`known` を引いてから重みを読み終えるまでに、別の対戦が決着していることがある。
    const human: SeatInfo = {
      playerId: account.playerId,
      displayName: account.displayName,
      rating: this.accounts.byPlayerId(account.playerId)?.rating ?? account.rating,
    };
    const botSeat: SeatInfo = {
      playerId: `${BOT_PLAYER_PREFIX}${bot.identity.name}`,
      displayName: `AI ${bot.identity.name}`,
      rating: null,
      bot: bot.identity,
    };
    // AI は座席 1 に座る。先攻は seed が決めるので、この順は有利不利を生まない。
    const [seated] = this.open(
      [request.deck, botDeck],
      [human, botSeat],
      [request.seedShareCommit ?? null, null],
      { seat: 1, bot },
    );
    const ticket = newToken();
    this.rememberSeated(ticket, seated);
    return { ok: true, ticket, seat: seated };
  }

  /**
   * AI との対戦を断る理由。無ければ null。呼び手は重みを読む前に一度これを通す（読み込みは Durable Object を止める）。
   *
   * **AI との対戦は 1 人 1 局までにする。** AI の座席は重みを抱え、放っておかれた対戦も
   * 持ち時間が尽きるまでメモリに残る。何局でも開けると、1 人で Durable Object のメモリを埋められる。
   */
  refuseBot(request: BotJoinRequest, known: Account | null, botDeck: DeckList): JoinOutcome | null {
    if (known === null) return accountMissing();
    // 続いている対戦はデッキより先に見る。いま組んでいるデッキが通らなくても、続いている対戦へは戻れる。
    // 続いている対戦の席を一緒に返す。シークレットが持ち主を示しているので、渡してよい。
    // 返さないと、画面を失った人は座席トークンを持たず、その対戦の持ち時間が尽きるまで次を始められない。
    const live = this.registry.botMatchOf(known.playerId);
    if (live !== null) {
      return {
        ok: false,
        code: BOT_MATCH_LIVE,
        errors: ["終わっていない AI との対戦がある。その対戦へ戻る。"],
        seat: live,
      };
    }
    const violations = validateDeck(request.deck);
    if (violations.length > 0) {
      return { ok: false, errors: violations.map(describeViolation) };
    }
    const botViolations = validateDeck(botDeck);
    if (botViolations.length > 0) {
      return {
        ok: false,
        errors: botViolations.map((violation) => `AI のデッキ: ${describeViolation(violation)}`),
      };
    }
    if (this.botJoining.has(known.playerId)) {
      return {
        ok: false,
        code: BOT_MATCH_LIVE,
        errors: ["AI との対戦を用意している途中である。"],
      };
    }
    return null;
  }

  /** 重みを読むあいだ、同じプレイヤーの次の要求を断る。`finally` で必ず外すこと。 */
  holdBotJoin(playerId: string): void {
    this.botJoining.add(playerId);
  }

  releaseBotJoin(playerId: string): void {
    this.botJoining.delete(playerId);
  }

  /**
   * 待っている人が相手を見つけたかどうかを引き換えに来るエンドポイント。
   *
   * **引き換えに来ても消さない。** 1 度読んだら消す作りだと、その応答が回線の不調で
   * 落ちただけで、次に来た人へ「もう降りている」と答えることになる。対戦のほうは
   * 始まっているので、その人は座らないまま時間切れで負ける。チケットが引き換えの鍵なので、
   * 同じチケットには同じ座席を返す。
   */
  claim(ticketId: string): ClaimOutcome {
    const seat = this.seated.get(ticketId);
    if (seat !== undefined) {
      /**
       * **終わった対戦と、降りたチケットは別である。** 取りに行く前に相手が投了するか
       * 時間切れになると席はもう無いが、それは「別のタブから入り直した」ではない。
       * 対戦はあったことにして、そう答える。生きているかどうかはレジストリが知っている。
       */
      if (!this.registry.holdsSeat(seat.seatToken)) {
        return { kind: "finished", matchId: seat.matchId };
      }
      return { kind: "seated", seat };
    }
    /**
     * 席そのものは溢れて捨てても、**終わった対戦があったことは答えられるようにする。**
     * ここで `unknown` を返すと、画面は「もう一度さがせ」と言う。その人はもう 1 局
     * 始めてしまうが、1 局目はレーティングを動かしログにも残っていて、本人はそこへ
     * 辿り着けない。
     */
    const finished = this.finished.get(ticketId);
    if (finished !== undefined) return { kind: "finished", matchId: finished };
    if (this.isWaiting(ticketId)) return { kind: "waiting" };
    return this.dropped.has(ticketId) ? { kind: "dropped" } : { kind: "unknown" };
  }

  /**
   * 席を覚える。溢れたときに捨てるのは、**対戦がもう終わっている席だけ**である。
   * 終わった席も、取りに来た人へ「もう終わっている」と答えるために少しは残る。
   *
   * 古い順に捨てると、まだ対戦中の人の席まで消える。その人は取りに来ても席をもらえず、
   * 画面は入り直せと言い、入り直せば 2 局目が始まって 1 局目は時間切れの負けとして残る。
   * 1 手も指していないのにである。
   *
   * **1 回に見るのは上限の数までにする。** 進んでいる対戦が上限を超えているときは、
   * 捨てられる席が無いので、全部を見ても何も減らない。覚える数は進んでいる対戦の数で
   * 頭打ちになり、それは 1 局ぶんの局面より小さい。
   */
  private rememberSeated(ticketId: string, seat: Seated): void {
    this.seated.set(ticketId, seat);
    if (this.seated.size <= this.seatedLimit) return;
    // 溢れたぶんだけを、古い順に捨てる。終わった席も「もう終わっている」と答えるために要るので、
    // 終わっているというだけでまとめて捨てない。
    let seen = 0;
    for (const [id, old] of this.seated) {
      if (this.seated.size <= this.seatedLimit || seen++ >= this.seatedLimit) break;
      if (id === ticketId) continue;
      if (this.registry.holdsSeat(old.seatToken)) continue;
      this.seated.delete(id);
      this.rememberFinished(id, old.matchId);
    }
  }

  /**
   * 捨てた席の対戦の識別子を覚える。席そのものより桁違いに小さいので、席の上限とは
   * 別に、もっと多く持てる。
   */
  private rememberFinished(ticketId: string, matchId: string): void {
    this.finished.delete(ticketId);
    this.finished.set(ticketId, matchId);
    while (this.finished.size > FINISHED_LIMIT) {
      const oldest = this.finished.keys().next().value;
      if (oldest === undefined) break;
      this.finished.delete(oldest);
    }
  }

  private isWaiting(ticketId: string): boolean {
    for (const waiting of this.waitingByRoom.values()) {
      if (waiting.ticket === ticketId) return true;
    }
    return this.queue.some((waiting) => waiting.ticket === ticketId);
  }

  /** そのプレイヤーが待っているものを、どこにいても降ろす。 */
  private dropWaiting(playerId: string): void {
    for (const [room, waiting] of this.waitingByRoom) {
      if (waiting.seat.playerId === playerId) {
        this.waitingByRoom.delete(room);
        this.rememberDropped(waiting.ticket);
      }
    }
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const waiting = this.queue[index];
      if (waiting?.seat.playerId === playerId) {
        this.queue.splice(index, 1);
        this.rememberDropped(waiting.ticket);
      }
    }
  }

  private rememberDropped(ticketId: string): void {
    this.dropped.add(ticketId);
    while (this.dropped.size > DROPPED_LIMIT) {
      const oldest = this.dropped.values().next().value;
      if (oldest === undefined) break;
      this.dropped.delete(oldest);
    }
  }

  /** 待つのをやめる。 */
  leave(ticketId: string): void {
    let found = false;
    for (const [room, waiting] of this.waitingByRoom) {
      if (waiting.ticket === ticketId) {
        this.waitingByRoom.delete(room);
        found = true;
      }
    }
    const index = this.queue.findIndex((waiting) => waiting.ticket === ticketId);
    if (index >= 0) {
      this.queue.splice(index, 1);
      found = true;
    }
    // 知らないチケットを「降ろした」と覚えない。覚えると、知らないものに「降りている」と答え、
    // 呼ばれた回数だけ本物の記録を押し出すことになる。
    if (found) this.rememberDropped(ticketId);
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

  /** チケットの座席を、今のレーティングと表示名で取り直す。メモリに無ければチケットのままを使う。 */
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

  /**
   * 座席を決める。どちらかがシェアのコミットを送っていれば、対戦はまだ始めない。
   * シェアが開くまで `seed` が決まらないので、局面も時計もまだ無い（6.4 節）。
   */
  private start(first: Ticket, second: Ticket): [Seated, Seated] {
    return this.open(
      [first.deck, second.deck],
      /**
       * レーティングは今この場で読み直す（7.2 節）。待っている間に別のタブの対戦が終われば
       * レーティングは動いている。チケットを取ったときの値を残すと、記録が「席が決まった時点」でなくなる。
       * 記録の `startedAt` も同じ時点にそろえる。
       */
      [this.seatNow(first), this.seatNow(second)],
      [first.shareCommit, second.shareCommit],
      null,
    );
  }

  private open(
    decks: [DeckList, DeckList],
    seats: [SeatInfo, SeatInfo],
    shareCommits: SeedShares,
    bot: BotSeat | null,
  ): [Seated, Seated] {
    const nowMs = this.now();
    const pending: PendingMatch = {
      matchId: randomUUID(),
      decks,
      seats,
      seatTokens: [newToken(), newToken()],
      spectatorToken: newToken(),
      startedAt: new Date(nowMs).toISOString(),
      server: commitSeed(),
      shareCommits,
      shares: noShares(),
      deadlineMs: nowMs + SHARE_REVEAL_DEADLINE_MS,
      bot,
    };
    if (allRevealed(pending)) this.registry.start(pending, nowMs);
    else this.registry.addPending(pending);
    const seated = (seat: Player): Seated => ({
      matchId: pending.matchId,
      seat,
      seatToken: pending.seatTokens[seat],
      seedCommit: pending.server.commit,
      seedShareCommits: pending.shareCommits,
    });
    return [seated(0), seated(1)];
  }
}
