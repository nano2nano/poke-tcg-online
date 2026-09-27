// @ts-check
/**
 * 画面が持つ対戦の状態と、それを進める reducer。
 *
 * いまの画面（`app.js`）と作り直している画面（`web/`）の両方が使うので、ビルドを通さずに
 * ブラウザが読める JS で書き、型は JSDoc で tsc に確かめさせる。DOM に触れず、受け取った値を
 * 書き換えない。同じ状態と同じメッセージからは、いつも同じ状態を返す。
 */

/**
 * @import { CardDefId, Move, Player, PlayerView, SpectatorView } from "../src/engine.js"
 * @import { AnswerDestination, DeckPlacementView, MulliganReveal, SetupView } from "../src/match.js"
 * @import { ClockView, EndedMessage, ServerMessage, SpectatorEndedMessage, SpectatorSeat } from "../src/protocol.js"
 * @import { ReplayFrame } from "../src/history.js"
 */

/**
 * 対戦準備で選びかけのバトル場とベンチ。局面が届き直しても、まだ出せる候補なら残す。
 *
 * @typedef {object} SetupDraft
 * @property {string | null} active
 * @property {string[]} bench
 * @property {boolean} sent 送って返事を待っている。2 度目はサーバが断り、通った答えまで失敗に見える。
 */

/**
 * @typedef {object} SeatState
 * @property {Player} seat
 * @property {string | null} matchId
 * @property {number} stateVersion
 * @property {PlayerView | null} view
 * @property {Move[] | null} legalMoves
 * @property {SetupView | null} setup
 * @property {DeckPlacementView | null} deckPlacement
 * @property {(AnswerDestination | null)[] | null} answerDestinations
 * @property {CardDefId[] | null} revealedDeck
 * @property {MulliganReveal[]} mulligans
 * @property {Player | null} firstPlayer
 * @property {ClockView | null} clock
 * @property {string | null} spectatorToken 終わった対戦では通らないので、決着したら null にする。
 * @property {Omit<EndedMessage, "t" | "view"> | null} ended
 * @property {SetupDraft} setupDraft
 */

/**
 * 画面の中で起きる操作。サーバへ送る手そのものは状態を変えず、返ってきた局面で変わる。
 *
 * @typedef {{ t: "choose-active"; instanceId: string }
 *   | { t: "toggle-bench"; instanceId: string }
 *   | { t: "setup-sent" }} SetupAction
 */

/** @typedef {ServerMessage | SetupAction} SeatAction */

/**
 * 座席に着いたときの状態。局面は、両者がシェアを開いたあとの `sync` で届く。
 *
 * @param {Player} seat
 * @returns {SeatState}
 */
export function initialSeatState(seat) {
  return {
    seat,
    matchId: null,
    stateVersion: 0,
    view: null,
    legalMoves: null,
    setup: null,
    deckPlacement: null,
    answerDestinations: null,
    revealedDeck: null,
    mulligans: [],
    firstPlayer: null,
    clock: null,
    spectatorToken: null,
    ended: null,
    setupDraft: emptyDraft(),
  };
}

/**
 * 準備のバトル場とベンチをまとめて選べる候補。選べないあいだは null。
 *
 * @param {SeatState} state
 */
export function setupOffer(state) {
  return state.ended === null && state.setup?.kind === "choose" ? state.setup : null;
}

/**
 * @param {SeatState} state
 * @param {SeatAction} action
 * @returns {SeatState}
 */
export function seatReducer(state, action) {
  switch (action.t) {
    case "sync":
    case "delta": {
      const next = {
        ...state,
        stateVersion: action.stateVersion,
        view: action.view,
        legalMoves: action.legalMoves,
        setup: action.setup,
        deckPlacement: action.deckPlacement,
        answerDestinations: action.answerDestinations,
        revealedDeck: action.revealedDeck,
        // delta が運ぶのは準備のあいだだけで、無ければ前のものから変わっていない。
        mulligans: action.mulligans ?? state.mulligans,
        clock: action.clock,
        ...(action.t === "sync"
          ? {
              matchId: action.matchId,
              firstPlayer: action.firstPlayer,
              spectatorToken: action.spectatorToken,
            }
          : {}),
      };
      // 準備の答えへの返事は、預かっても断っても局面で届く。ここで戻さないと、断られたあとに出し直せない。
      return withDraft(next, { ...state.setupDraft, sent: false });
    }
    case "ended": {
      const { t: _t, view, ...ended } = action;
      return withDraft(
        {
          ...state,
          view,
          legalMoves: null,
          setup: null,
          deckPlacement: null,
          answerDestinations: null,
          revealedDeck: null,
          spectatorToken: null,
          ended,
        },
        emptyDraft(),
      );
    }
    case "choose-active": {
      if (setupOffer(state) === null) return state;
      const active = state.setupDraft.active === action.instanceId ? null : action.instanceId;
      return withDraft(state, { ...state.setupDraft, active });
    }
    case "toggle-bench": {
      const offer = setupOffer(state);
      if (offer === null) return state;
      const { bench } = state.setupDraft;
      if (bench.includes(action.instanceId)) {
        return withDraft(state, {
          ...state.setupDraft,
          bench: bench.filter((id) => id !== action.instanceId),
        });
      }
      if (bench.length >= offer.benchSlots) return state;
      return withDraft(state, { ...state.setupDraft, bench: [...bench, action.instanceId] });
    }
    case "setup-sent":
      if (state.setupDraft.active === null || state.setupDraft.sent) return state;
      return { ...state, setupDraft: { ...state.setupDraft, sent: true } };
    default:
      return state;
  }
}

/** @returns {SetupDraft} */
function emptyDraft() {
  return { active: null, bench: [], sent: false };
}

/**
 * 選びかけを、いま出せる候補に合わせて置く。バトル場に選んだカードはベンチから外す。
 *
 * @param {SeatState} state
 * @param {SetupDraft} draft
 * @returns {SeatState}
 */
function withDraft(state, draft) {
  const offer = setupOffer(state);
  if (offer === null) return { ...state, setupDraft: emptyDraft() };
  const active = draft.active !== null && offer.active.includes(draft.active) ? draft.active : null;
  const bench = draft.bench
    .filter((id) => offer.bench.includes(id) && id !== active)
    .slice(0, offer.benchSlots);
  return { ...state, setupDraft: { active, bench, sent: draft.sent } };
}

/**
 * @typedef {object} WatchState
 * @property {number} stateVersion
 * @property {SpectatorView | null} view
 * @property {[SpectatorSeat, SpectatorSeat] | null} seats
 * @property {Player | null} firstPlayer
 * @property {ClockView | null} clock
 * @property {Omit<SpectatorEndedMessage, "t" | "view"> | null} ended
 */

/** @returns {WatchState} */
export function initialWatchState() {
  return { stateVersion: 0, view: null, seats: null, firstPlayer: null, clock: null, ended: null };
}

/**
 * @param {WatchState} state
 * @param {ServerMessage} message
 * @returns {WatchState}
 */
export function watchReducer(state, message) {
  switch (message.t) {
    case "spectator-sync":
      return {
        ...state,
        stateVersion: message.stateVersion,
        view: message.view,
        seats: message.seats,
        firstPlayer: message.firstPlayer,
        clock: message.clock,
      };
    case "spectator-delta":
      return {
        ...state,
        stateVersion: message.stateVersion,
        view: message.view,
        clock: message.clock,
      };
    case "spectator-ended": {
      const { t: _t, view, ...ended } = message;
      return { ...state, view, ended };
    }
    default:
      return state;
  }
}

/**
 * 開いているリプレイ。局面はサーバが毎回作り直すので、ここには辿る位置と直近の 1 枚だけを持つ。
 *
 * @typedef {object} ReplayState
 * @property {string} matchId
 * @property {Player} seat
 * @property {number} ply 描けている手数。
 * @property {number} wanted 頼んだ手数。まだ返ってきていないぶんを含む。
 * @property {number} moveCount 辿れる上限。再現できない地点があれば、そこまで下がる。
 * @property {number} asked 出した問い合わせの番号。返ってくる順は、出した順と同じとは限らない。
 * @property {ReplayFrame | null} frame
 */

/**
 * @typedef {{ t: "ask"; ply: number }
 *   | { t: "frame"; asked: number; frame: ReplayFrame }
 *   | { t: "failed"; asked: number }} ReplayAction
 */

/**
 * @param {{ matchId: string; seat: Player; moveCount: number }} summary
 * @returns {ReplayState}
 */
export function initialReplayState({ matchId, seat, moveCount }) {
  return { matchId, seat, ply: 0, wanted: 0, moveCount, asked: 0, frame: null };
}

/**
 * `ask` のあとの `asked` を問い合わせに添え、返ってきたら `frame` か `failed` で戻す。
 *
 * **最後に出した問い合わせの答えしか描かない。** 「1 手 ▶」を続けて押すと、出した順と返る順が
 * 入れ替わる。あとから来た古い盤面で上書きすると、手数の表示と盤面がずれたまま残る。
 *
 * @param {ReplayState} state
 * @param {ReplayAction} action
 * @returns {ReplayState}
 */
export function replayReducer(state, action) {
  switch (action.t) {
    case "ask":
      return {
        ...state,
        asked: state.asked + 1,
        wanted: Math.max(0, Math.min(action.ply, state.moveCount)),
      };
    case "frame": {
      if (action.asked !== state.asked) return state;
      const { frame } = action;
      // 辿れる上限を下げないと、「さいごまで」がその先を頼み続け、毎回同じ手数が返って進まないように見える。
      if (frame.divergedAt !== null) {
        return { ...state, frame, ply: frame.ply, wanted: frame.ply, moveCount: frame.divergedAt };
      }
      return { ...state, frame, ply: frame.ply };
    }
    case "failed":
      // 行き先を戻さないと、1 度失敗しただけで次に押したぶんが 1 手飛ぶ。
      if (action.asked !== state.asked) return state;
      return { ...state, wanted: state.ply };
    default:
      return state;
  }
}
