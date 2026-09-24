/**
 * 座席と WebSocket の接続を束ねる（`docs/spec/battle-server.md` 3 節）。
 *
 * **時刻を読むのはこの層だけである。** 下の層（`match.ts`、`clock.ts`）は現在時刻を
 * 引数で受け取るので、時計の進みをテストで書ける。
 *
 * 座席へ出る値は `syncFor` / `deltaFor` が、観戦者へ出る値は `spectatorSyncFor` /
 * `spectatorDeltaFor` が組み立てるものに限る。`match.ts` の `viewFor` / `spectatorViewFor` /
 * `eventsFor` / `legalMovesFor` を通さない経路をここに作らない（1 節の S-2）。
 */

import type { DomainEvent, Move, Player } from "./engine.js";
import {
  botKnowledgeFor,
  clockView,
  concede,
  deckPlacementFor,
  engineOutcome,
  eventsFor,
  legalMovesFor,
  setupViewFor,
  spectatorViewFor,
  submitMove,
  submitSetup,
  toMove,
  viewFor,
  type BotSeat,
  type Match,
} from "./match.js";
import {
  SEAT_NOT_FOUND,
  SEAT_REPLACED,
  type ClientMessage,
  type DeltaMessage,
  type ServerMessage,
  type SpectatorDeltaMessage,
  type SpectatorSyncMessage,
  type SyncMessage,
} from "./protocol.js";
import type { MatchRegistry, PendingSeatRef } from "./registry.js";
import { allRevealed, reveal, type PendingMatch } from "./pending.js";
import type { MatchRecord } from "./log.js";

/** 送り先。Worker の WebSocket を包んだもの（`src/worker.ts`）がこの形を満たす。テストでは素のオブジェクトを渡す。 */
export interface SeatSocket {
  send(data: string): void;
  close(): void;
}

/**
 * 観戦者の上限（3.6 節）。観戦者 1 人ぶん、1 手ごとにフルの `view` を 1 通送るので、
 * 観戦トークンを知る 1 人が接続を積むだけで送信がいくらでも膨らむ。
 * 全体にも置くのは、自分で対戦を開いて積むことを対戦の数だけ繰り返せるからである。
 */
export const MAX_SPECTATORS_PER_MATCH = 32;
export const MAX_SPECTATORS = 1_024;

export interface HubOptions {
  registry: MatchRegistry;
  now?: () => number;
  /** 対戦が終わってレジストリを離れたあとに 1 度だけ呼ぶ。記録を残し、レーティングを動かすのはここである。 */
  onFinish?: (record: MatchRecord) => void;
  /** AI が手を指すまでの間。既定は `BOT_DELAY_MS`。 */
  botDelayMs?: number;
}

/**
 * AI が手を指すまでの間（7.3 節）。AI が手を選ぶ時間は人が画面を追う時間よりずっと短いので、
 * 間を置かないと番が回ってきた瞬間に何手も進み、人は画面で何が起きたかを追えない。
 */
export const BOT_DELAY_MS = 700;

export class MatchHub {
  /** 対戦 ID → 座席 → 接続。1 座席に 1 本だけ持つ。 */
  private readonly sockets = new Map<string, Map<Player, SeatSocket>>();
  /** 対戦 ID → 観戦者の接続。 */
  private readonly spectators = new Map<string, Set<SeatSocket>>();
  /** 観戦者の接続 → 対戦 ID。観戦者の数はこの大きさで数え、別の数え方を持たない。 */
  private readonly spectatorOf = new Map<SeatSocket, string>();
  private readonly now: () => number;
  /** 対戦 ID → AI が次の手を指すタイマー。1 局に 1 つだけ持つ。 */
  private readonly botTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly botDelayMs: number;

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? (() => Date.now());
    this.botDelayMs = options.botDelayMs ?? BOT_DELAY_MS;
  }

  /**
   * 座席トークンで座席に就く。再接続もこれ 1 つで、特別な復元の手順は要らない
   * （局面はサーバが持っている）。同じ座席に 2 本目が繋がったら古いほうを閉じる。
   */
  attach(socket: SeatSocket, seatToken: string, seedShare: string | null = null): boolean {
    const pending = this.options.registry.pendingBySeatToken(seatToken);
    if (pending !== undefined) {
      this.seatSocket(pending.pending.matchId, pending.seat, socket);
      send(socket, { t: "pending" });
      this.acceptShare(socket, pending, seedShare);
      return true;
    }
    const ref = this.options.registry.bySeatToken(seatToken);
    if (ref === undefined) {
      send(socket, {
        t: "error",
        message: "座席が見つからない（対戦が終わっているか、座席トークンが違う）",
        code: SEAT_NOT_FOUND,
      });
      return false;
    }
    this.seatSocket(ref.match.matchId, ref.seat, socket);
    send(socket, this.syncFor(ref.match, ref.seat));
    // シェアを出さずに入った対戦は、ロビーの中で始まっている。AI が先に指すなら、ここで動かす。
    this.driveBot(ref.match);
    return true;
  }

  private seatSocket(matchId: string, seat: Player, socket: SeatSocket): void {
    const perMatch = this.sockets.get(matchId) ?? new Map<Player, SeatSocket>();
    const previous = perMatch.get(seat);
    if (previous !== undefined && previous !== socket) {
      send(previous, {
        t: "error",
        message: "同じ座席に別の接続が繋がったので、この接続は閉じる",
        code: SEAT_REPLACED,
      });
      previous.close();
    }
    perMatch.set(seat, socket);
    this.sockets.set(matchId, perMatch);
  }

  private acceptShare(socket: SeatSocket, ref: PendingSeatRef, seedShare: string | null): void {
    if (reveal(ref.pending, ref.seat, seedShare) === "mismatch") {
      send(socket, { t: "error", message: "シェアが、参加のときに送ったコミットと合わない" });
    }
    if (allRevealed(ref.pending)) this.startPending(ref.pending);
  }

  /**
   * **始められなかった対戦は捨てる。** ここは接続を受けた処理と定期処理から呼ばれるので、
   * 投げると呼んだ側の処理ごと止まる。残すと、次のスイープでも同じ形で失敗し続け、両座席は
   * 始まらない対戦を待ち続ける。
   */
  private startPending(pending: PendingMatch): void {
    const perMatch = this.sockets.get(pending.matchId);
    let match: Match;
    try {
      match = this.options.registry.start(pending, this.now());
    } catch (error) {
      console.error(`対戦を始められなかった（${pending.matchId}）:`, error);
      this.options.registry.dropPending(pending);
      this.sockets.delete(pending.matchId);
      for (const socket of perMatch?.values() ?? []) {
        send(socket, { t: "error", message: "対戦を始められなかった" });
        socket.close();
      }
      return;
    }
    for (const seat of [0, 1] as Player[]) {
      const socket = perMatch?.get(seat);
      if (socket !== undefined) send(socket, this.syncFor(match, seat));
    }
    this.driveBot(match);
  }

  /** 溢れたら断る。座席と違い、観戦は断っても誰も負けない。 */
  attachSpectator(socket: SeatSocket, spectatorToken: string): boolean {
    const match = this.options.registry.bySpectatorToken(spectatorToken);
    if (match === undefined) {
      send(socket, {
        t: "error",
        message: "対戦が見つからない（終わっているか、観戦トークンが違う）",
      });
      return false;
    }
    const watching = this.spectators.get(match.matchId) ?? new Set<SeatSocket>();
    if (watching.size >= MAX_SPECTATORS_PER_MATCH || this.spectatorOf.size >= MAX_SPECTATORS) {
      send(socket, { t: "error", message: "観戦している人が多すぎる" });
      return false;
    }
    watching.add(socket);
    this.spectators.set(match.matchId, watching);
    this.spectatorOf.set(socket, match.matchId);
    send(socket, this.spectatorSyncFor(match));
    return true;
  }

  detach(socket: SeatSocket): void {
    const watched = this.spectatorOf.get(socket);
    if (watched !== undefined) {
      this.spectatorOf.delete(socket);
      const watching = this.spectators.get(watched);
      watching?.delete(socket);
      if (watching?.size === 0) this.spectators.delete(watched);
      return;
    }
    for (const [matchId, perMatch] of this.sockets) {
      for (const [seat, held] of perMatch) {
        if (held === socket) perMatch.delete(seat);
      }
      if (perMatch.size === 0) this.sockets.delete(matchId);
    }
  }

  handleSpectator(socket: SeatSocket, spectatorToken: string, message: ClientMessage): void {
    const match = this.options.registry.bySpectatorToken(spectatorToken);
    if (match === undefined) {
      send(socket, { t: "error", message: "対戦が見つからない" });
      return;
    }
    switch (message.t) {
      case "hello":
        send(socket, this.spectatorSyncFor(match));
        return;
      case "ping":
        send(socket, { t: "pong" });
        return;
      case "move":
      case "setup":
      case "concede":
        send(socket, { t: "error", message: "観戦している接続からは指せない" });
        return;
    }
  }

  /** 始まる前の対戦には局面が無い。答えられるのは生存確認と、まだ始まっていないことだけである。 */
  private handlePending(socket: SeatSocket, message: ClientMessage): void {
    switch (message.t) {
      case "ping":
        send(socket, { t: "pong" });
        return;
      case "hello":
        send(socket, { t: "pending" });
        return;
      case "move":
      case "setup":
      case "concede":
        send(socket, { t: "error", message: "対戦はまだ始まっていない" });
        return;
    }
  }

  /** 1 通を処理する。`seatToken` は `attach` 済みのものを呼び出し側が持つ。 */
  handle(socket: SeatSocket, seatToken: string, message: ClientMessage): void {
    if (this.options.registry.pendingBySeatToken(seatToken) !== undefined) {
      this.handlePending(socket, message);
      return;
    }
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
        /**
         * **手の形を見るのはエンジンである。** `clientMessageSchema` が見るのは封筒までで、
         * ここへ来る `move` は「object である」しか分かっていない。`submitMove` は
         * `legalMoves` と構造ごと突き合わせてから適用するので、合法手と 1 欄でも違えば
         * `illegal-move` で落ちる。型を合わせるためだけの変換をここに置く。
         */
        const outcome = submitMove(
          match,
          seat,
          message.stateVersion,
          message.move as unknown as Move,
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
      case "setup": {
        const outcome = submitSetup(match, seat, message.active, message.bench, this.now());
        if (!outcome.ok) {
          send(socket, { t: "reject", reason: outcome.reason, stateVersion: match.version });
          send(socket, this.syncFor(match, seat));
          return;
        }
        // 順番が来ていなければ局面は動かない。変わったのは出した座席の画面だけである。
        if (outcome.events.length === 0) send(socket, this.syncFor(match, seat));
        else this.broadcastDelta(match, outcome.events);
        if (match.result !== null) this.endMatch(match);
        return;
      }
      case "concede":
        if (concede(match, seat, this.now())) this.endMatch(match);
        return;
    }
  }

  /**
   * その座席トークンの対戦で AI の番なら、AI を動かす。
   *
   * シェアを出さずに入った対戦はロビーの中で始まり、ハブを通らない。AI が先に選ぶ局面から始まると、
   * 人が繋ぐまで誰も AI を動かさず、AI の持ち時間だけが流れる。席を渡した直後に呼ぶ。
   */
  wakeBot(seatToken: string): void {
    const ref = this.options.registry.bySeatToken(seatToken);
    if (ref !== undefined) this.driveBot(ref.match);
  }

  /**
   * AI の番なら、間を置いて AI に 1 手指させる（7.3 節）。何度呼んでも、待っている手は 1 局に 1 つである。
   * 局面が動くところ（対戦の開始、手を受理したあと）と、座席が就いたところから呼ぶ。
   */
  private driveBot(match: Match): void {
    const bot = match.bot;
    if (bot === null || this.botTimers.has(match.matchId) || !isToMove(match, bot.seat)) return;
    const timer = setTimeout(() => {
      this.botTimers.delete(match.matchId);
      try {
        this.botMove(match, bot);
      } catch (error) {
        console.error(`AI の手を進められなかった。投了で終える（${match.matchId}）:`, error);
        this.botResigns(match, bot.seat);
      }
    }, this.botDelayMs);
    this.botTimers.set(match.matchId, timer);
  }

  /**
   * AI の 1 手。AI に渡すのは座席の射影と合法手と、その座席へ射影したイベントから追った知識だけで、
   * 人の座席に届くもの以上は渡さない（1 節の S-2）。
   *
   * **AI が指せなかったら、AI の投了で終える。** 方策が投げたときも、手が断られたときも同じである。
   * 代わりに一様に選んだ手を指すと、方策が選んでいない手が `source: "bot"` として記録に混ざる。
   * 止めたまま待たせると、人は AI の持ち時間が尽きるまで待たされる。
   */
  private botMove(match: Match, { seat, bot }: BotSeat): void {
    // 待っているあいだに終わった対戦（投了、時間切れ）には指さない。
    if (this.options.registry.bySeatToken(match.seatTokens[seat])?.match !== match) return;
    const legal = legalMovesFor(match, seat);
    if (legal === null) return;
    let move: Move | undefined;
    try {
      const view = viewFor(match, seat);
      move = legal[bot.choose(view, legal, botKnowledgeFor(match, view))];
    } catch (error) {
      console.error(
        `AI ${bot.identity.name} が手を選べなかった。投了で終える（${match.matchId}）:`,
        error,
      );
    }
    if (move === undefined) {
      this.botResigns(match, seat);
      return;
    }
    const outcome = submitMove(match, seat, match.version, move, this.now(), null, "bot");
    if (!outcome.ok) {
      console.error(`AI の手が断られた。投了で終える（${match.matchId}）: ${outcome.reason}`);
      this.botResigns(match, seat);
      return;
    }
    this.broadcastDelta(match, outcome.events);
    if (match.result !== null) this.endMatch(match);
  }

  /** AI の投了で終える。もう終わっている対戦には何もしない。 */
  private botResigns(match: Match, seat: Player): void {
    if (this.options.registry.bySeatToken(match.seatTokens[seat])?.match !== match) return;
    if (concede(match, seat, this.now())) this.endMatch(match);
  }

  /** 決着を両座席と観戦者へ伝え、レジストリから外す。 */
  endMatch(match: Match): void {
    const botTimer = this.botTimers.get(match.matchId);
    if (botTimer !== undefined) clearTimeout(botTimer);
    this.botTimers.delete(match.matchId);
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
        seedShares: match.seedCommitment.shares,
        view: viewFor(match, seat),
      });
      // 座席トークンはもう通らないので、開いたままだと画面の `ping` のたびに
      // 「座席が見つからない」が返り続ける。
      socket.close();
    }
    this.sockets.delete(match.matchId);
    /**
     * 観戦者の接続は、決着を伝えたら閉じる。数から外すだけで開いたままにすると、
     * 対戦を開いて観戦者を積んでは終わらせることを繰り返すだけで、上限に数えられない
     * 接続がいくらでも溜まる。座席と違い、終わった対戦へ観戦者が送るものは無い。
     */
    const watching = this.spectators.get(match.matchId) ?? new Set<SeatSocket>();
    const ended =
      match.result === null
        ? null
        : serialize({
            t: "spectator-ended",
            matchResult: match.result,
            outcome: engineOutcome(match),
            view: spectatorViewFor(match),
          });
    for (const socket of watching) {
      this.spectatorOf.delete(socket);
      if (ended !== null) socket.send(ended);
      socket.close();
    }
    this.spectators.delete(match.matchId);
    // `retire` は同じ対戦を二度外さないので、`onFinish` も 1 局につき 1 度である。
    const record = this.options.registry.retire(match);
    if (record === null) return;
    try {
      this.options.onFinish?.(record);
    } catch (error) {
      // 決着そのものはもう済んでいる。後始末で投げても、伝えた決着は取り消さない。
      console.error(`決着の後始末に失敗した（${match.matchId}）:`, error);
    }
  }

  /**
   * シェアを開く期限を過ぎた対戦を始め、持ち時間の尽きた対戦を終わらせる。呼ぶのは起動側の定期処理である。
   *
   * **1 局ずつ切り離す。** 1 局の後始末で投げると、同じスイープで終わらせるはずだった
   * ほかの対戦が、時計を過ぎたまま残り続ける。
   */
  sweepTimeouts(): void {
    // 始めた対戦では、来ない座席の時計が流れる（3.4 節）。
    for (const pending of this.options.registry.overdue(this.now())) this.startPending(pending);
    for (const match of this.options.registry.sweepTimeouts(this.now())) {
      try {
        this.endMatch(match);
      } catch (error) {
        console.error(`対戦を終われなかった（${match.matchId}）:`, error);
      }
    }
  }

  private broadcastDelta(match: Match, events: DomainEvent[]): void {
    const perMatch = this.sockets.get(match.matchId);
    for (const seat of [0, 1] as Player[]) {
      const socket = perMatch?.get(seat);
      if (socket !== undefined) send(socket, this.deltaFor(match, seat, events));
    }
    this.driveBot(match);
    const watching = this.spectators.get(match.matchId);
    if (watching === undefined) return;
    // 観戦者はみな同じ値を受けるので、組み立ても JSON にするのも 1 度で足りる。
    const delta = serialize(this.spectatorDeltaFor(match, events));
    for (const socket of watching) socket.send(delta);
  }

  private syncFor(match: Match, seat: Player): SyncMessage {
    return {
      t: "sync",
      matchId: match.matchId,
      seat,
      stateVersion: match.version,
      view: viewFor(match, seat),
      legalMoves: legalMovesFor(match, seat),
      setup: setupViewFor(match, seat),
      deckPlacement: deckPlacementFor(match, seat),
      mulligans: match.mulligans,
      firstPlayer: match.firstPlayer,
      clock: clockView(match, this.now()),
      seedCommit: match.seedCommitment.commit,
      spectatorToken: match.spectatorToken,
    };
  }

  private deltaFor(match: Match, seat: Player, events: DomainEvent[]): DeltaMessage {
    return {
      t: "delta",
      stateVersion: match.version,
      events: eventsFor(events, seat),
      view: viewFor(match, seat),
      legalMoves: legalMovesFor(match, seat),
      setup: setupViewFor(match, seat),
      deckPlacement: deckPlacementFor(match, seat),
      // マリガンは準備の中でしか起きないので、対戦が始まったあとは送り直さない。
      ...(match.state.phase === "setup" ? { mulligans: match.mulligans } : {}),
      clock: clockView(match, this.now()),
    };
  }

  private spectatorSyncFor(match: Match): SpectatorSyncMessage {
    const [first, second] = match.seats;
    return {
      t: "spectator-sync",
      stateVersion: match.version,
      view: spectatorViewFor(match),
      firstPlayer: match.firstPlayer,
      clock: clockView(match, this.now()),
      seats: [
        { displayName: first.displayName, rating: first.rating },
        { displayName: second.displayName, rating: second.rating },
      ],
    };
  }

  private spectatorDeltaFor(match: Match, events: DomainEvent[]): SpectatorDeltaMessage {
    return {
      t: "spectator-delta",
      stateVersion: match.version,
      events: eventsFor(events, "spectator"),
      view: spectatorViewFor(match),
      clock: clockView(match, this.now()),
    };
  }
}

/** 手番側かどうか。テストと配信層が同じ判定を使う。 */
export function isToMove(match: Match, seat: Player): boolean {
  return toMove(match) === seat;
}

function send(socket: SeatSocket, message: ServerMessage): void {
  socket.send(serialize(message));
}

function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}
