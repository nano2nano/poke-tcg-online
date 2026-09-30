/**
 * 観戦で届いた局面を溜めて、見る人の速さで送る（仕様 3.6 節、7.4 節）。
 *
 * 局面は届いた順に全部持つ。止めているあいだに届いたものも捨てず、戻るときはここから描き直す。
 * 1 局の局面の数は手数と同じで、AI どうしの対戦でもサーバが送る量を越えない。
 */

import type { Player, SpectatorView } from "../../src/engine.js";
import type { ClockView } from "../../src/protocol.js";
import type { Notice, Side } from "./describe.js";

/**
 * 描くものだけを持つ。AI どうしの対戦では座席ごとに射影が届くが、相手の側は同じ盤面を伏せただけなので捨てる。
 * 局面は 1 局ぶん溜まるので、持つ量はそのままメモリに効く。
 */
export interface WatchFrame {
  stateVersion: number;
  /** 両者の手札まで描くか。両座席とも AI の対戦で、座席の射影が届いたときだけ真。 */
  open: boolean;
  /** 座席ごとの場。添字は座席。 */
  sides: [Side, Side];
  stadium: SpectatorView["stadium"];
  clock: ClockView | null;
  /** この局面へ来た手。繋いだ直後の局面と、人が座る対戦には無い。 */
  moved: { seat: Player; text: string; targets: string[] } | null;
  /** できごとの記録に足す行。古い順。 */
  lines: string[];
  /** この局面へ 1 手ずつ進んだときに出す通知。 */
  notices: Notice[];
}

/**
 * 1 手の演出が終わってから次の手を見せるまでの間の選択肢。0 は演出を待たず、届いたらすぐ描く。
 */
export const STEP_CHOICES: readonly { ms: number; label: string }[] = [
  { ms: 2_000, label: "2 秒" },
  { ms: 1_000, label: "1 秒" },
  { ms: 500, label: "0.5 秒" },
  { ms: 250, label: "0.25 秒" },
  { ms: 0, label: "届きしだい" },
];

/**
 * 人が選ぶまでの間。AI どうしの対戦はサーバが人の目より速く指すので 1 手ずつ間を置き、
 * 人が座る対戦は指されたときに見せる。
 */
function defaultStepMs(open: boolean): number {
  return open ? 1_000 : 0;
}

export interface Playback {
  frames: WatchFrame[];
  /** 描いている局面の位置。局面がまだ無ければ -1。 */
  at: number;
  playing: boolean;
  /** 人が選んだ、演出のあとの間。選ぶまでは null で、`defaultStepMs` に従う。 */
  stepMs: number | null;
  /**
   * 最後の送りが、届いた順に局面を見せたものか。通知を出すのはそのときだけにする。
   * 戻ったときや最新へ飛んだときに出すと、描いている局面と合わない結果が画面の上に並ぶ。
   */
  stepped: boolean;
}

export type PlaybackAction =
  | { t: "arrive"; frame: WatchFrame }
  | { t: "tick" }
  | { t: "forward" }
  | { t: "back" }
  | { t: "latest" }
  | { t: "play" }
  | { t: "pause" }
  | { t: "speed"; stepMs: number };

export function initialPlayback(): Playback {
  return { frames: [], at: -1, playing: true, stepMs: null, stepped: false };
}

export function stepMsOf(playback: Playback): number {
  return playback.stepMs ?? defaultStepMs(playback.frames[0]?.open === true);
}

export function playbackReducer(state: Playback, action: PlaybackAction): Playback {
  const last = state.frames.length - 1;
  switch (action.t) {
    case "arrive": {
      // 繋ぎ直した `spectator-sync` は、局面が動いていなければ同じ局面をもう一度運ぶ。
      if (last >= 0 && state.frames[last]!.stateVersion === action.frame.stateVersion) return state;
      const frames = [...state.frames, action.frame];
      // 最初の局面と、届きしだい描いているあいだは、届いたものをそのまま描く。
      const follow = state.at < 0 || (state.playing && stepMsOf({ ...state, frames }) === 0);
      if (!follow) return { ...state, frames };
      return { ...state, frames, at: frames.length - 1, stepped: true };
    }
    case "tick":
      if (!state.playing || state.at >= last) return state;
      return { ...state, at: state.at + 1, stepped: true };
    case "forward":
      if (state.at >= last) return { ...state, playing: false };
      return { ...state, at: state.at + 1, playing: false, stepped: true };
    case "back":
      return { ...state, at: Math.max(0, state.at - 1), playing: false, stepped: false };
    case "latest":
      return { ...state, at: last, playing: true, stepped: false };
    case "play":
      return caughtUp({ ...state, playing: true });
    case "pause":
      return { ...state, playing: false };
    case "speed":
      return caughtUp({ ...state, stepMs: action.stepMs });
    default:
      return state;
  }
}

/** 届きしだい描いているなら、溜まっている分を飛ばして最後に届いた局面へ行く。 */
function caughtUp(state: Playback): Playback {
  const last = state.frames.length - 1;
  if (!state.playing || stepMsOf(state) !== 0 || state.at >= last) return state;
  return { ...state, at: last, stepped: false };
}
