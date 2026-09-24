/**
 * 1 対戦の実行時（`docs/spec/battle-server.md` 2 節）。
 *
 * 権威の `GameState` を持ち、座席から来た手を検査して `applyMove` へ通す。
 * 現在時刻は必ず引数で受け取る。時刻を読むのは配信層（`src/hub.ts`）1 箇所だけである。
 *
 * 座席と観戦者へ出る値の組み立て（`viewFor` / `spectatorViewFor` / `eventsFor` /
 * `legalMovesFor`）もここに置く。
 * **`state` と生の `events` を外へ返す関数をこのモジュールに作らないこと。** 射影を
 * 迂回する経路ができると、1 節の S-2 が守れなくなる。
 */

import {
  applyMove,
  benchCapacity,
  createGame,
  createRng,
  isBasicPokemon,
  legalMoves,
  movesEqual,
  nextInt,
  opponent,
  playerView,
  projectEvents,
  spectatorView,
} from "./engine.js";
import type {
  CardDefId,
  CardInstance,
  Choice,
  ChoiceAnswer,
  DeckList,
  DomainEvent,
  GameOutcome,
  GameState,
  InPlayId,
  Move,
  Player,
  PlayerEvent,
  PlayerView,
  SpectatorView,
  Viewer,
  Zone,
} from "./engine.js";
import { randomBytes } from "node:crypto";
import { consume, createClock, isTimedOut, moveRemainingMs, type Clock } from "./clock.js";
import { commitSeed, noShares, type SeedCommitment, type SeedShares } from "./fingerprint.js";
import type { ClockView, RejectReason } from "./protocol.js";
import type { Bot, BotIdentity } from "./bots.js";

export interface SeatInfo {
  /** サーバが発行した識別子。対戦をまたいで同じ人を指す（7.2 節）。 */
  playerId: string;
  displayName: string;
  /**
   * 対戦を始めた時点のレーティング。あとから座席と人を結び直すことはできないので、
   * ここで持たなければこの対戦には二度と付けられない。
   * 終わったあとのレーティングは、対戦の並びから導けるので持たない。
   * AI の座席は null である。AI はレーティングを持たず、AI との対戦はレーティングを動かさない（7.3 節）。
   */
  rating: number | null;
  /** AI の座席だけが持つ。どの重みが指したか（7.3 節）。 */
  bot?: BotIdentity;
}

/** AI が座る座席と、その AI。 */
export interface BotSeat {
  seat: Player;
  bot: Bot;
}

/**
 * 対戦の決着（2.3 節）。エンジンの `GameOutcome` とは別に持つ。
 * 投了と時間切れはルール上の敗北条件ではないので、`WinReason` へ足さない。
 */
export type MatchResult =
  | { kind: "normal"; winner: Player | null }
  | { kind: "concede"; winner: Player; conceded: Player }
  | { kind: "timeout"; winner: Player; timedOut: Player };

/** ログへ残す 1 手（6.2 節）。 */
export interface LoggedMove {
  move: Move;
  /** その手を選ぶのに掛かった時間。自己対戦では手に入らない量である。 */
  elapsedMs: number;
  /** 手の出どころ。AI の座席の手は `bot` である（7.3 節）。 */
  source: "human" | "bot";
  /**
   * そのとき規則が許していた手の数と、選ばれた手のその中での位置。
   *
   * どちらも再生で作り直せる。持つ理由は学習ではなく照合である（6.2 節）。
   * これが無いと、合法手の集合が変わった再生も黙って通る。
   */
  candidates: number;
  chosen: number;
  /**
   * 画面が実際に人へ見せた手の、`legalMoves` の中での位置。全部見せたなら null。
   *
   * これだけは再生で作り直せない（6.2 節）。見せなかった手まで「人が選ばなかった手」
   * として学ぶと、模倣も評価も歪む。クライアントの自己申告で、規則の判定には使わない。
   */
  offered: number[] | null;
}

export interface Match {
  readonly matchId: string;
  readonly seedCommitment: SeedCommitment;
  /** 参加のときに座席が送った、シェアのコミット。開いたシェアが本物かを記録から検算するために残す。 */
  readonly seedShareCommits: SeedShares;
  readonly decks: [DeckList, DeckList];
  readonly seats: [SeatInfo, SeatInfo];
  readonly seatTokens: [string, string];
  /**
   * 座席ごとではなく対戦に 1 つ。観戦者に見えるものは、どちらの座席も相手について
   * 見えているものに収まるので、どちらが配っても相手に不利は生じない（3.6 節）。
   */
  readonly spectatorToken: string;
  readonly startedAt: string;
  /** 先攻。seed から決まる導出値で、再生の入力ではない。先攻の偏りを測るために残す。 */
  readonly firstPlayer: Player;
  /** AI の座席。人どうしの対戦では null。 */
  readonly bot: BotSeat | null;
  state: GameState;
  /**
   * 対戦準備で、座席がまとめて出したバトル場とベンチ（2.4 節）。エンジンの順番が来るまで預かる。
   * 準備が終われば両方 null に戻す。
   */
  setupPlans: [SetupPlan | null, SetupPlan | null];
  /**
   * 対戦準備で、座席ごとに次の答えを考え始めた時刻。準備は両座席が同時に考え始めるので、
   * 手番の起点（`turnStartedAtMs`）とは別に持つ。
   */
  setupSinceMs: [number, number];
  /**
   * 対戦準備で引き直すときに見せた手札（2.4 節）。公開の情報だが、マリガンは座席の手の外
   * （対戦の開始や相手の手の途中）で起きるので、イベントだけでは届かない座席がある。
   */
  mulligans: MulliganReveal[];
  /**
   * 1 つの効果で、選んだカードを山札の端へ順に置いているあいだの、置いた分（3.2 節の `deckPlacement`）。
   * 置き終えるか、ほかの手が挟まれば null に戻る。
   */
  deckStack: DeckStack | null;
  /**
   * 手番側の座席へ送る `deckPlacement`。手を適用するたびに 1 度だけ求める。
   * 求めるときに乱数を使うので、送るたびに求め直すと、同じ局面の `delta` と `sync` で食い違いうる。
   */
  deckPlacement: DeckPlacementView | null;
  /** 効果の選択が続くあいだに、選ぶ座席へ山札から見せたカード（`answerDestinations` で使う）。 */
  effectReveals: EffectReveals | null;
  /**
   * 手番側の座席へ送る `answerDestinations`。`deckPlacement` と同じく、手を適用するたびに 1 度だけ求める。
   * AI の座席では画面が無いので求めない。
   */
  answerDestinations: (AnswerDestination | null)[] | null;
  /** 1 手の適用ごとに 1 増える。`state.eventSeq` を流用しない（2.2 節）。 */
  version: number;
  clocks: [Clock, Clock];
  moves: LoggedMove[];
  /** 手番側が今の手を考え始めた時刻。 */
  turnStartedAtMs: number;
  result: MatchResult | null;
  endedAt: string | null;
}

export interface CreateMatchOptions {
  matchId: string;
  decks: [DeckList, DeckList];
  seats: [SeatInfo, SeatInfo];
  seatTokens: [string, string];
  spectatorToken: string;
  nowMs: number;
  startedAt: string;
  /** テストのために固定したいときだけ渡す。既定は 256 ビットの乱数。 */
  seedCommitment?: SeedCommitment;
  seedShareCommits?: SeedShares;
  bankMs?: number;
  bot?: BotSeat | null;
}

export function createMatch(options: CreateMatchOptions): Match {
  const seedCommitment = options.seedCommitment ?? commitSeed();
  const created = createGame({ seed: seedCommitment.seed, decks: options.decks });
  return {
    matchId: options.matchId,
    seedCommitment,
    seedShareCommits: options.seedShareCommits ?? noShares(),
    decks: options.decks,
    seats: options.seats,
    seatTokens: options.seatTokens,
    spectatorToken: options.spectatorToken,
    startedAt: options.startedAt,
    firstPlayer: firstPlayerOf(created.events),
    bot: options.bot ?? null,
    state: created.state,
    setupPlans: [null, null],
    setupSinceMs: [options.nowMs, options.nowMs],
    mulligans: revealedHands(created.events),
    deckStack: null,
    deckPlacement: null,
    effectReveals: null,
    answerDestinations: null,
    version: 0,
    clocks: [createClock(options.bankMs), createClock(options.bankMs)],
    moves: [],
    turnStartedAtMs: options.nowMs,
    result: null,
    endedAt: null,
  };
}

/**
 * 今、手を持っている座席（2.1 節）。
 *
 * 選択待ちがあれば最上段の `Choice` の owner、無ければ手番プレイヤーである。
 * **両者が同時に手を持つ状態は存在しない**ので、座席と手番の対応をサーバ側で別に持たない。
 */
export function toMove(match: Match): Player | null {
  if (match.result !== null || match.state.phase === "gameover") return null;
  return match.state.choices.at(-1)?.owner ?? match.state.turnPlayer;
}

export type SubmitOutcome =
  | { ok: true; events: DomainEvent[] }
  | { ok: false; reason: RejectReason };

/**
 * 手を 1 つ受理する。検査の順は 2.2 節のとおりで、入れ替えない。
 * 検査に落ちても `match` は変わらない（対戦は続く）。
 */
export function submitMove(
  match: Match,
  seat: Player,
  stateVersion: number,
  move: Move,
  nowMs: number,
  offered: number[] | null = null,
  source: LoggedMove["source"] = "human",
): SubmitOutcome {
  const mover = toMove(match);
  if (mover === null) return { ok: false, reason: "match-over" };
  if (mover !== seat) return { ok: false, reason: "not-your-turn" };
  if (stateVersion !== match.version) return { ok: false, reason: "stale-version" };

  const legal = legalMoves(match.state);
  const chosen = legal.findIndex((candidate) => movesEqual(candidate, move));
  if (chosen < 0) {
    return { ok: false, reason: "illegal-move" };
  }

  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  const events = record(match, seat, move, legal, chosen, {
    elapsedMs,
    chargedMs: elapsedMs,
    nowMs,
    offered: normalizeOffered(offered, legal.length),
    source,
  });
  return { ok: true, events: [...events, ...drainSetupPlans(match, nowMs)] };
}

/** 手を 1 つ適用して記録する。合法かどうかは呼び出し側が確かめてある。 */
function record(
  match: Match,
  seat: Player,
  move: Move,
  legal: Move[],
  chosen: number,
  timing: {
    elapsedMs: number;
    chargedMs: number;
    nowMs: number;
    offered: number[] | null;
    source: LoggedMove["source"];
  },
): DomainEvent[] {
  const answered = move.type === "AnswerChoice" ? match.state.choices.at(-1) : undefined;
  const applied = applyMove(match.state, move);
  match.state = applied.state;
  match.deckStack = nextDeckStack(match.deckStack, answered, move, applied);
  match.deckPlacement = deckPlacementOf(match.state, match.deckStack);
  match.effectReveals = nextEffectReveals(match.effectReveals, applied);
  match.answerDestinations =
    toMove(match) === match.bot?.seat
      ? null
      : answerDestinationsOf(match.state, match.effectReveals);
  match.version += 1;
  match.moves.push({
    move,
    elapsedMs: timing.elapsedMs,
    source: timing.source,
    candidates: legal.length,
    chosen,
    offered: timing.offered,
  });
  match.clocks[seat] = consume(match.clocks[seat], timing.chargedMs);
  match.turnStartedAtMs = timing.nowMs;
  match.setupSinceMs[seat] = timing.nowMs;
  match.mulligans.push(...revealedHands(applied.events));
  // 引き直した座席は、新しい手札が来てから考え始める。
  for (const event of applied.events) {
    if (event.kind === "mulligan-taken") match.setupSinceMs[event.player] = timing.nowMs;
  }

  if (match.state.phase === "gameover") {
    finish(match, { kind: "normal", winner: match.state.outcome?.winner ?? null }, timing.nowMs);
  }
  return applied.events;
}

/**
 * 準備の 1 つの答え。カードは `defId` で持つ。エンジンは同じカードを 1 枚に畳んで候補にするので、
 * 座席が選んだのと同じインスタンスが候補に出るとは限らない。`defId` が null なら「ベンチに出し終える」。
 */
interface SetupStep {
  kind: "setup-place-active" | "setup-place-bench";
  defId: CardDefId | null;
}

export interface SetupPlan {
  /** 座席が選んだインスタンス。画面へ返して、出したものを見せる。 */
  active: string;
  bench: string[];
  /** まだエンジンへ流していない答え。 */
  steps: SetupStep[];
  /** 答えを出すのに掛かった時間。記録には最初に流す 1 手へ載せる。 */
  elapsedMs: number;
  started: boolean;
}

/** 引き直すときに相手へ見せた手札（3.2 節の `mulligans`）。 */
export interface MulliganReveal {
  player: Player;
  cards: CardDefId[];
}

/** 座席の画面に出す準備の状態（3.2 節の `setup`）。 */
export type SetupView =
  | { kind: "choose"; active: string[]; bench: string[]; benchSlots: number }
  | { kind: "submitted"; active: string; bench: string[] };

/**
 * 相手の準備を仮の答えで進める回数の上限。準備の選択は有限なので、越えるのはエンジンが想定外に
 * 回り続けたときだけで、そのときはまとめて受け取らない。
 */
const LOOKAHEAD_LIMIT = 64;

/**
 * `seat` の次の準備の選択まで、相手の選択を仮の答えで進めた局面。準備の選択の中でなければ null。
 *
 * 準備の選択肢は、その座席の手札と、その座席がそれまでに出した答えだけで決まる。
 * 相手の答えを何にしても `seat` の選択肢は変わらないので、仮の答えで先へ進めてよい。
 * ただし先読みの途中で `seat` 自身が引き直すと、戻り値の手札はまだ見せていないものになる。
 * 座席に候補を見せる側（`planStart`）が手札の一致を確かめる。
 * バトル場の仮の答えに「出さない」は使わない。出さないとマリガンになり、山札を切り直す。
 */
function lookahead(state: GameState, seat: Player): GameState | null {
  let current = state;
  for (let step = 0; step < LOOKAHEAD_LIMIT; step++) {
    if (current.phase !== "setup") return null;
    const top = current.choices.at(-1);
    if (top === undefined) return null;
    if (top.owner === seat) return current;
    const legal = legalMoves(current);
    const standIn =
      top.kind === "setup-place-active"
        ? legal.find((move) => move.type === "AnswerChoice" && move.answer.kind === "card")
        : top.kind === "setup-place-bench" || top.kind === "setup-bonus-draw"
          ? legal.find((move) => move.type === "AnswerChoice" && move.answer.kind === "decline")
          : undefined;
    if (standIn === undefined) return null;
    current = applyMove(current, standIn).state;
  }
  return null;
}

/** 準備の答えを、いまの局面の合法手に直す。合う手が無ければ undefined。 */
function resolveStep(
  state: GameState,
  seat: Player,
  step: SetupStep,
  legal: Move[] = legalMoves(state),
): Move | undefined {
  const top = state.choices.at(-1);
  if (top?.owner !== seat || top.kind !== step.kind) return undefined;
  const hand = state.players[seat].hand;
  return legal.find((move) => {
    if (move.type !== "AnswerChoice") return false;
    if (step.defId === null) return move.answer.kind === "decline";
    if (move.answer.kind !== "card") return false;
    const card = move.answer.card;
    return hand.find((each) => each.instanceId === card)?.defId === step.defId;
  });
}

/**
 * バトル場とベンチを 1 度に出せるなら、その局面。
 *
 * 「出さない」を選べるバトル場（たねが無く、特性で出られるカードだけのとき）は含めない。
 * 出さないとマリガンで手札が変わり、まとめて出した残りの答えが意味を失う。
 */
function planStart(match: Match, seat: Player): GameState | null {
  if (match.result !== null || match.setupPlans[seat] !== null) return null;
  const ahead = lookahead(match.state, seat);
  const top = ahead?.choices.at(-1);
  if (ahead === null || top?.kind !== "setup-place-active" || top.optional) return null;
  if (!sameHand(match.state.players[seat].hand, ahead.players[seat].hand)) return null;
  return ahead;
}

/**
 * 先読みの途中で手札が変わったか。変わるのはその座席が引き直すときで、マリガンはまだ起きていない。
 * 先読みの手札で選ばせると、見せる前の手札を渡すことになる。
 */
function sameHand(now: readonly CardInstance[], ahead: readonly CardInstance[]): boolean {
  if (now.length !== ahead.length) return false;
  const ids = new Set(now.map((card) => card.instanceId));
  return ahead.every((card) => ids.has(card.instanceId));
}

export function setupViewFor(match: Match, seat: Player): SetupView | null {
  if (match.state.phase !== "setup") return null;
  const plan = match.setupPlans[seat];
  if (plan !== null) return { kind: "submitted", active: plan.active, bench: plan.bench };
  const ahead = planStart(match, seat);
  if (ahead === null) return null;
  const top = ahead.choices.at(-1);
  const candidates = top?.prompt.kind === "selectCard" ? top.prompt.candidates : [];
  const hand = ahead.players[seat].hand;
  const activeDefs = new Set(
    hand.filter((card) => candidates.includes(card.instanceId)).map((card) => card.defId),
  );
  return {
    kind: "choose",
    active: hand.filter((card) => activeDefs.has(card.defId)).map((card) => card.instanceId),
    // バトル場と違い、ベンチの候補はたねポケモンだけで、しゅんぱつりょくのカードは入らない。
    bench: hand.filter((card) => isBasicPokemon(card.defId)).map((card) => card.instanceId),
    benchSlots: benchCapacity(ahead, seat),
  };
}

/**
 * 対戦準備のバトル場とベンチを 1 度に受け取る（2.4 節）。
 *
 * 手番でない座席からも受け取り、エンジンの順番が来たところで 1 手ずつ流す。
 * 受け取る前に、仮の答えで進めた局面で全部を通してみる。通らない答えは預からない。
 */
export function submitSetup(
  match: Match,
  seat: Player,
  active: string,
  bench: string[],
  nowMs: number,
): SubmitOutcome {
  if (match.result !== null) return { ok: false, reason: "match-over" };
  const start = planStart(match, seat);
  if (start === null) {
    return { ok: false, reason: toMove(match) === seat ? "illegal-move" : "not-your-turn" };
  }
  const chosen = [active, ...bench];
  const hand = start.players[seat].hand;
  const defIds = chosen.map((id) => hand.find((card) => card.instanceId === id)?.defId);
  if (new Set(chosen).size !== chosen.length || defIds.includes(undefined)) {
    return { ok: false, reason: "illegal-move" };
  }
  const steps: SetupStep[] = defIds.map((defId, index) => ({
    kind: index === 0 ? "setup-place-active" : "setup-place-bench",
    defId: defId as CardDefId,
  }));

  let current = start;
  for (const step of steps) {
    const ahead = lookahead(current, seat);
    const move = ahead === null ? undefined : resolveStep(ahead, seat, step);
    if (ahead === null || move === undefined) return { ok: false, reason: "illegal-move" };
    current = applyMove(ahead, move).state;
  }
  // 出せるたねが尽きるか枠が埋まれば、エンジンが自分でベンチを閉じる。閉じなかったときだけ答える。
  const rest = lookahead(current, seat);
  if (rest?.choices.at(-1)?.kind === "setup-place-bench") {
    steps.push({ kind: "setup-place-bench", defId: null });
  }

  match.setupPlans[seat] = {
    active,
    bench: [...bench],
    steps,
    elapsedMs: Math.max(0, nowMs - match.setupSinceMs[seat]),
    started: false,
  };
  return { ok: true, events: drainSetupPlans(match, nowMs) };
}

/**
 * 預かった準備の答えを、エンジンの順番が来たぶんだけ流す。
 *
 * 流す時点でも合法手と突き合わせる。合わなければその座席の残りを捨て、1 手ずつ答えてもらう。
 * 時計は、答えを出したときにその座席の時計が流れていたぶんだけ引く。
 */
function drainSetupPlans(match: Match, nowMs: number): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (;;) {
    if (match.result !== null || match.state.phase !== "setup") {
      match.setupPlans = [null, null];
      return events;
    }
    const seat = toMove(match) as Player;
    const plan = match.setupPlans[seat];
    const step = plan?.steps[0];
    const legal = legalMoves(match.state);
    const move = step === undefined ? undefined : resolveStep(match.state, seat, step, legal);
    if (plan === null || move === undefined) {
      match.setupPlans[seat] = null;
      return events;
    }
    plan.steps.shift();
    const first = !plan.started;
    plan.started = true;
    const running = Math.max(0, nowMs - match.turnStartedAtMs);
    events.push(
      ...record(match, seat, move, legal, legal.indexOf(move), {
        elapsedMs: first ? plan.elapsedMs : 0,
        chargedMs: first ? Math.min(running, plan.elapsedMs) : 0,
        nowMs,
        offered: null,
        source: "human",
      }),
    );
  }
}

/** 投了する。`Move` ではないので `state` は動かない（2.3 節）。 */
export function concede(match: Match, seat: Player, nowMs: number): boolean {
  if (match.result !== null) return false;
  finish(match, { kind: "concede", winner: opponent(seat), conceded: seat }, nowMs);
  return true;
}

/**
 * 手番側の持ち時間が尽きていれば、その座席の時間切れ負けで終える（3.4 節）。
 *
 * 自動の手は指さない。その人が選んでいない手を、その人の座席の名前でログへ混ぜないためである。
 * 切断中も時計は流れるので、この判定に接続の生死は要らない。
 */
export function applyTimeout(match: Match, nowMs: number): boolean {
  const mover = toMove(match);
  if (mover === null) return false;
  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  if (!isTimedOut(match.clocks[mover], elapsedMs)) return false;
  finish(match, { kind: "timeout", winner: opponent(mover), timedOut: mover }, nowMs);
  return true;
}

/**
 * 座席 0 から見た結果。勝ち 1・引き分け 0.5・負け 0。レーティングの計算がこれを使う。
 *
 * 投了と時間切れも普通の勝敗として数える。規則上の敗北条件ではない（2.3 節）ことは
 * `matchResult.kind` が区別して持っているので、レーティングの側で分ける必要はない。
 */
export function scoreForSeatZero(result: MatchResult): number {
  if (result.kind === "normal" && result.winner === null) return 0.5;
  return result.winner === 0 ? 1 : 0;
}

/** エンジンが付けた勝敗。投了と時間切れでは対戦が途中なので null になる。 */
export function engineOutcome(match: Match): GameOutcome | null {
  return match.state.outcome;
}

export function viewFor(match: Match, seat: Player): PlayerView {
  return playerView(match.state, seat);
}

export function spectatorViewFor(match: Match): SpectatorView {
  return spectatorView(match.state);
}

export function eventsFor(events: DomainEvent[], viewer: Viewer): PlayerEvent[] {
  return projectEvents(events, viewer);
}

/**
 * 手番側の座席にだけ合法手を返す（4.1 節）。
 *
 * 帯域の話ではない。手番側の合法手にはその人の手札のカードが現れるので、
 * 相手へ送ると手札が割れる。
 */
export function legalMovesFor(match: Match, seat: Player): Move[] | null {
  return toMove(match) === seat ? legalMoves(match.state) : null;
}

/** 選んだカードを山札へ順に置く効果で、置いた分。`source` は効果を起こしたカードのインスタンス ID。 */
export interface DeckStack {
  owner: Player;
  source: string;
  /** 置いた順。 */
  placed: CardInstance[];
}

/**
 * 座席の画面に出す、今選ぶカードが山札のどこへ入るか（3.2 節の `deckPlacement`）。
 * 上の端でも下の端でも、選んだカードは先に置いた分のすぐ下へ入る。
 */
export interface DeckPlacementView {
  edge: "top" | "bottom";
  /** この効果で置く何枚目か。1 から数える。 */
  nth: number;
  /** この効果で先に置いたカード。置いた順で、山札でも上から同じ順に並ぶ。 */
  above: CardDefId[];
}

/** 置き終えるまでの先読みで、答える回数の上限。越えるのはエンジンが想定外に回り続けたときだけ。 */
const PLACEMENT_LOOKAHEAD_LIMIT = 16;

/**
 * 山札の並びと乱数の種を替えて試す回数（`disguised`）。山札を切る効果では、置いたカードが
 * たまたま端に並ぶ確率が 1 回ごとにおよそ山札の枚数分の 1 で、コインで行き先が変わる効果なら 2 分の 1 で、
 * 回数だけ掛け合わさる。
 */
const DISGUISE_TRIES = 8;

export function deckPlacementFor(match: Match, seat: Player): DeckPlacementView | null {
  return toMove(match) === seat ? match.deckPlacement : null;
}

/**
 * 選んだカードを山札の上か下へ順に置く選択（「好きな順番に入れ替えて、山札の上にもどす」型）のあいだ、
 * 今選ぶカードがどこへ入るか。そのほかの選択では null。
 *
 * エンジンの選択はカードを 1 枚ずつ選ばせるだけで、何枚目を選んでいるかも、選んだカードの行き先も
 * 座席へ渡さない。名前でカードを特別扱いせず、答えてみて見分ける。
 *
 * 試すのは、選ぶ座席に見えない山札の並びと乱数の種を差し替えた局面である。本物の局面で試すと、
 * これから切る結果や山札の並びが、出すか出さないかに表れて座席へ漏れる。
 */
export function deckPlacementOf(
  state: GameState,
  stack: DeckStack | null,
): DeckPlacementView | null {
  const choice = state.choices.at(-1);
  if (choice?.source == null) return null;
  const seat = choice.owner;
  const source = choice.source.instanceId;
  const placed = stack !== null && continuesStack(stack, choice) ? stack.placed : [];
  try {
    const edge = stackedEdge(state, seat, source, placed);
    if (edge === null) return null;
    for (let tried = 1; tried < DISGUISE_TRIES; tried++) {
      if (stackedEdge(state, seat, source, placed) !== edge) return null;
    }
    if (!everyAnswerStacks(state, seat, placed, edge)) return null;
    return { edge, nth: placed.length + 1, above: placed.map((card) => card.defId) };
  } catch {
    // 先読みは誰も選んでいない道をたどる。そこでエンジンが例外を上げても、指された手は適用済みなので止めない。
    return null;
  }
}

/**
 * 先頭の候補で答え続けて効果を終えたとき、先に置いた分（`placed`）とこれから置く分が、
 * 山札のどちらかの端に置いた順で並ぶなら、その端。
 * 途中で山札を切る効果は、並びが乱数で決まるので、試すたびに端に並んだり並ばなかったりする。
 */
function stackedEdge(
  state: GameState,
  seat: Player,
  source: string,
  placed: readonly CardInstance[],
): "top" | "bottom" | null {
  let current = disguised(state, seat, placed);
  const order = placed.map((card) => card.instanceId);
  for (let step = 0; ; step++) {
    const choice = current.choices.at(-1);
    if (choice?.owner !== seat || choice.source?.instanceId !== source) break;
    if (step >= PLACEMENT_LOOKAHEAD_LIMIT) return null;
    const answer = legalMoves(current).find(isCardAnswer);
    if (answer === undefined) return null;
    const applied = applyMove(current, answer);
    const moved = chosenIntoDeck(answer, applied.events, seat);
    // 今の選択そのものが山札へ置かないなら、置く順番の問題ではない。
    if (moved === null && step === 0) return null;
    if (moved !== null) order.push(moved.instanceId);
    current = applied.state;
  }
  const deck = current.players[seat].deck.map((card) => card.instanceId);
  if (sameOrder(deck.slice(0, order.length), order)) return "top";
  if (sameOrder(deck.slice(-order.length), order)) return "bottom";
  return null;
}

/**
 * どの候補を選んでも、先に置いた分のすぐ下の同じ端へ入るか。先読みは先頭の候補しかたどらないが、
 * 見出しはすべての候補のボタンに付く。カードによって行き先の変わる効果では付けない。
 */
function everyAnswerStacks(
  state: GameState,
  seat: Player,
  placed: readonly CardInstance[],
  edge: "top" | "bottom",
): boolean {
  const current = disguised(state, seat, placed);
  return legalMoves(current)
    .filter(isCardAnswer)
    .every((answer) => {
      const applied = applyMove(current, answer);
      const moved = chosenIntoDeck(answer, applied.events, seat);
      if (moved === null) return false;
      const order = [...placed, moved].map((card) => card.instanceId);
      const deck = applied.state.players[seat].deck.map((card) => card.instanceId);
      return sameOrder(
        edge === "top" ? deck.slice(0, order.length) : deck.slice(-order.length),
        order,
      );
    });
}

/** 選ぶ座席に見えない山札の並びと、乱数の種を差し替えた局面。先に置いた分はその位置に残す。 */
function disguised(state: GameState, seat: Player, placed: readonly CardInstance[]): GameState {
  let rng = createRng(randomBytes(16).toString("hex"));
  const kept = new Set(placed.map((card) => card.instanceId));
  const deck = [...state.players[seat].deck];
  const slots = deck.flatMap((card, index) => (kept.has(card.instanceId) ? [] : [index]));
  for (let last = slots.length - 1; last > 0; last--) {
    const [pick, next] = nextInt(rng, last + 1);
    rng = next;
    const a = slots[last] as number;
    const b = slots[pick] as number;
    [deck[a], deck[b]] = [deck[b] as CardInstance, deck[a] as CardInstance];
  }
  const players: GameState["players"] = [state.players[0], state.players[1]];
  players[seat] = { ...state.players[seat], deck };
  return { ...state, rng, players };
}

function isCardAnswer(move: Move): boolean {
  return (
    move.type === "AnswerChoice" && (move.answer.kind === "card" || move.answer.kind === "cardDef")
  );
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * 答えで選んだカードが持ち主の山札へ入ったなら、そのカード。
 * 同じ手でほかのカードが山札へ入っても拾わない。拾うと、座席に見えないカードの `defId` を `above` で渡しうる。
 */
function chosenIntoDeck(move: Move, events: DomainEvent[], owner: Player): CardInstance | null {
  if (move.type !== "AnswerChoice") return null;
  const answer = move.answer;
  for (const event of events) {
    if (event.kind !== "card-moved" || event.to.kind !== "deck" || event.to.player !== owner) {
      continue;
    }
    if (answerPicks(answer, event.card)) return event.card;
  }
  return null;
}

/** カードを選ぶ答えが、そのカードを指すか。`cardDef` は同じカードのどれを選んだかを持たない。 */
function answerPicks(answer: ChoiceAnswer, card: CardInstance): boolean {
  if (answer.kind === "card") return card.instanceId === answer.card;
  return answer.kind === "cardDef" && card.defId === answer.defId;
}

function continuesStack(stack: DeckStack, choice: Choice): boolean {
  return choice.owner === stack.owner && choice.source?.instanceId === stack.source;
}

/** 手を 1 つ適用したあとの `deckStack`。同じ効果の選択が続くあいだだけ、山札へ入れたカードを足していく。 */
function nextDeckStack(
  stack: DeckStack | null,
  answered: Choice | undefined,
  move: Move,
  applied: { state: GameState; events: DomainEvent[] },
): DeckStack | null {
  const next = applied.state.choices.at(-1);
  if (answered?.source == null || next === undefined) return null;
  const current: DeckStack = {
    owner: answered.owner,
    source: answered.source.instanceId,
    placed: stack !== null && continuesStack(stack, answered) ? stack.placed : [],
  };
  if (!continuesStack(current, next)) return null;
  const moved = chosenIntoDeck(move, applied.events, answered.owner);
  return moved === null ? current : { ...current, placed: [...current.placed, moved] };
}

/**
 * 効果の選択への答えで、選んだカードがどこへ行くか（3.2 節の `answerDestinations`）。
 * `attached` は、カードを選ぶ答えならそのカードを、場のポケモンを選ぶ答えならそこへついたカードを `cards` に持つ。
 */
export type AnswerDestination =
  | {
      to: "hand" | "discard" | "lostZone" | "deck" | "prizes" | "active" | "bench";
      player: Player;
    }
  | { to: "revealed" }
  | { to: "attached" | "evolved"; target: InPlayId; cards: CardDefId[] };

export function answerDestinationsFor(
  match: Match,
  seat: Player,
): (AnswerDestination | null)[] | null {
  return toMove(match) === seat ? match.answerDestinations : null;
}

/** 1 つの効果の選択が続くあいだに、選ぶ座席へ山札から見せたカード。 */
export interface EffectReveals {
  owner: Player;
  /** 効果を起こしたカードのインスタンス ID。 */
  source: string;
  defIds: CardDefId[];
}

/**
 * 効果の選択のあいだ、合法手ごとの、その答えで選んだカードの行き先（`legalMoves` と同じ並び）。
 * そのほかの局面と、行き先が 1 つも分からないときは null。
 *
 * エンジンの選択はカードかポケモンを選ばせるだけで、選んだものをどうするかを座席へ渡さない。
 * 「手札に加える 1 枚」と「ポケモンにつける 1 枚」を同じ候補から続けて選ぶ効果では、
 * それが無いとどちらを選んでいるのか分からない。名前でカードを特別扱いせず、答えてみて見分ける。
 * 先読みは 1 手だけで、次の選択で行き先が決まるカードには付けない。
 *
 * `deckPlacementOf` と同じく、試すのは選ぶ座席に見えない山札の並びと乱数の種を差し替えた局面で、
 * どの回でも同じ行き先になった答えにだけ付ける。
 */
export function answerDestinationsOf(
  state: GameState,
  reveals: EffectReveals | null,
): (AnswerDestination | null)[] | null {
  const choice = state.choices.at(-1);
  if (choice?.source == null) return null;
  const known = knownTo(state, choice, reveals);
  const legal = legalMoves(state);
  let found: (AnswerDestination | null)[] = legal.map(() => null);
  for (let tried = 0; tried < DISGUISE_TRIES; tried++) {
    const current = disguised(state, choice.owner, []);
    const each = legal.map((move, index) =>
      tried > 0 && found[index] === null ? null : destinationOf(state, current, move, known),
    );
    found =
      tried === 0
        ? each
        : each.map((destination, index) =>
            JSON.stringify(destination) === JSON.stringify(found[index]) ? destination : null,
          );
    if (found.every((destination) => destination === null)) return null;
  }
  return found;
}

/**
 * 座席が正体を知っているカードか。場のポケモンを選ぶ答えで、ついたカードの `defId` を渡してよいかの判定に使う。
 * 山札のカードは、この効果で見せたものと同じカードだけを知っているとみなす。
 */
function knownTo(
  state: GameState,
  choice: Choice,
  reveals: EffectReveals | null,
): (card: CardInstance) => boolean {
  const known = [...state.players[choice.owner].hand];
  for (const side of state.players) {
    known.push(...side.discard, ...side.lostZone);
    for (const pokemon of [side.active, ...side.bench]) {
      if (pokemon !== null) known.push(...pokemon.stack, ...pokemon.attached);
    }
  }
  const ids = new Set(known.map((card) => card.instanceId));
  const shown = new Set(reveals !== null && continuesEffect(reveals, choice) ? reveals.defIds : []);
  const deck = new Set(state.players[choice.owner].deck.map((card) => card.instanceId));
  return (card) => ids.has(card.instanceId) || (deck.has(card.instanceId) && shown.has(card.defId));
}

/**
 * 答えを 1 つ適用して、選んだカードが最初に動いた先。動かずに公開されただけなら `revealed`。
 * `state` は本物の局面、`current` はそれを `disguised` で差し替えた局面で、適用するのは `current` である。
 */
function destinationOf(
  state: GameState,
  current: GameState,
  move: Move,
  known: (card: CardInstance) => boolean,
): AnswerDestination | null {
  if (move.type !== "AnswerChoice") return null;
  const answer = move.answer;
  let events: DomainEvent[];
  try {
    events = applyMove(current, move).events;
  } catch {
    // `deckPlacementOf` と同じく、先読みの例外で指された手を止めない。ほかの答えの行き先は残す。
    return null;
  }
  if (answer.kind === "inPlay") {
    const attached = events.flatMap((event) =>
      (event.kind === "energy-attached" || event.kind === "tool-attached") &&
      event.target === answer.target
        ? [event.card]
        : [],
    );
    if (attached.length === 0 || !attached.every(known)) return null;
    return { to: "attached", target: answer.target, cards: attached.map((card) => card.defId) };
  }
  // 同じカードが選んだゾーンの外にもあると、`cardDef` の答えはそちらの移動にも当たる。
  const prompt = state.choices.at(-1)?.prompt;
  const from =
    answer.kind === "cardDef" && prompt?.kind === "selectFromHiddenZone"
      ? new Set(cardsIn(current, prompt.zone).map((card) => card.instanceId))
      : null;
  const chosen = (card: CardInstance): boolean =>
    answerPicks(answer, card) && (from === null || from.has(card.instanceId));
  let revealed = false;
  for (const event of events) {
    switch (event.kind) {
      case "card-moved":
      case "pokemon-played":
        if (!chosen(event.card)) break;
        if (event.to.kind === "stadium") return null;
        return { to: event.to.kind, player: event.to.player };
      case "card-drawn":
        if (chosen(event.card)) return { to: "hand", player: event.player };
        break;
      case "card-discarded":
        if (chosen(event.card)) return { to: "discard", player: event.player };
        break;
      case "energy-attached":
      case "tool-attached":
        if (chosen(event.card)) {
          return { to: "attached", target: event.target, cards: [event.card.defId] };
        }
        break;
      case "pokemon-evolved":
        if (chosen(event.card)) {
          return { to: "evolved", target: event.target, cards: [event.card.defId] };
        }
        break;
      case "cards-revealed":
        // 相手のカードを見せる効果は「相手に見せる」と書けないので、自分のカードに限る。
        if (
          event.audience === "public" &&
          event.zone.kind !== "stadium" &&
          event.zone.player === move.player &&
          event.cards.some(chosen)
        ) {
          revealed = true;
        }
        break;
    }
  }
  return revealed ? { to: "revealed" } : null;
}

function cardsIn(state: GameState, zone: Zone): CardInstance[] {
  if (zone.kind === "stadium" || zone.kind === "active" || zone.kind === "bench") return [];
  return state.players[zone.player][zone.kind];
}

function continuesEffect(reveals: EffectReveals, choice: Choice): boolean {
  return choice.owner === reveals.owner && choice.source?.instanceId === reveals.source;
}

/**
 * 手を 1 つ適用したあとの `effectReveals`。同じ効果の選択が続くあいだだけ、
 * 選ぶ座席へ山札から見せたカードを足していく。
 */
function nextEffectReveals(
  reveals: EffectReveals | null,
  applied: { state: GameState; events: DomainEvent[] },
): EffectReveals | null {
  const next = applied.state.choices.at(-1);
  if (next?.source == null) return null;
  const kept = reveals !== null && continuesEffect(reveals, next) ? reveals.defIds : [];
  const shown = applied.events.flatMap((event) =>
    event.kind === "cards-revealed" &&
    event.player === next.owner &&
    event.zone.kind === "deck" &&
    event.zone.player === next.owner
      ? event.cards.map((card) => card.defId)
      : [],
  );
  return { owner: next.owner, source: next.source.instanceId, defIds: [...kept, ...shown] };
}

export function clockView(match: Match, nowMs: number): ClockView {
  const mover = toMove(match);
  const elapsedMs = Math.max(0, nowMs - match.turnStartedAtMs);
  return {
    bankMs: [match.clocks[0].bankMs, match.clocks[1].bankMs],
    moveRemainingMs: mover === null ? null : moveRemainingMs(match.clocks[mover], elapsedMs),
    toMove: mover,
  };
}

function finish(match: Match, result: MatchResult, nowMs: number): void {
  match.result = result;
  match.endedAt = new Date(nowMs).toISOString();
}

/**
 * クライアントの自己申告を、記録に載せてよい形へ均す。
 *
 * 規則の判定には使わない値なので、壊れていても手を拒まない。合法手の範囲に無い位置と
 * 重複を落とし、全部見せたのと同じなら null（＝全部）へ畳む。
 */
function normalizeOffered(offered: number[] | null, candidates: number): number[] | null {
  if (offered === null) return null;
  const kept = [...new Set(offered)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < candidates)
    .sort((a, b) => a - b);
  return kept.length === candidates ? null : kept;
}

/**
 * マリガンで見せた手札。準備の中で自分の手札を全員に見せる理由はマリガンのほかに無いので、それで拾う。
 * 両座席へ送るので、見せる相手が限られた公開は拾わない。
 */
function revealedHands(events: DomainEvent[]): MulliganReveal[] {
  return events.flatMap((event) =>
    event.kind === "cards-revealed" &&
    event.audience === "public" &&
    event.zone.kind === "hand" &&
    event.zone.player === event.player &&
    event.window.kind === "setup"
      ? [{ player: event.zone.player, cards: event.cards.map((card) => card.defId) }]
      : [],
  );
}

/** `game-started` が運ぶ先攻を読む。イベントの語彙が唯一の出どころである。 */
function firstPlayerOf(events: DomainEvent[]): Player {
  for (const event of events) {
    if (event.kind === "game-started") return event.firstPlayer;
  }
  throw new Error("createGame が game-started を出さなかった");
}
