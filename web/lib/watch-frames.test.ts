import { describe, expect, it } from "vitest";
import type { Side } from "./describe.js";
import {
  initialPlayback,
  playbackReducer,
  stepMsOf,
  type Playback,
  type PlaybackAction,
  type WatchFrame,
} from "./watch-frames.js";

/** 盤面の中身は送りの判断に使わないので、形だけの局面にする。 */
function frame(stateVersion: number, open: boolean): WatchFrame {
  return {
    stateVersion,
    open,
    sides: [{} as Side, {} as Side],
    stadium: null,
    clock: null,
    moved: null,
    lines: [],
    notices: [],
  };
}

function run(actions: PlaybackAction[], from: Playback = initialPlayback()): Playback {
  return actions.reduce(playbackReducer, from);
}

function arrived(count: number, open: boolean): PlaybackAction[] {
  return Array.from({ length: count }, (_, index) => ({ t: "arrive", frame: frame(index, open) }));
}

describe("観戦の送り", () => {
  it("AI どうしの対戦は、届いても最初の局面に留まり、1 手ずつ送る", () => {
    const state = run(arrived(4, true));
    expect(stepMsOf(state)).toBe(1_000);
    expect(state.at).toBe(0);
    const ticked = run([{ t: "tick" }], state);
    expect(ticked).toMatchObject({ at: 1, stepped: true });
  });

  it("最初に届いた局面の結果は出す。対戦準備の中で繋いだときの先攻の通知がここに載る", () => {
    expect(run(arrived(1, true))).toMatchObject({ at: 0, stepped: true });
  });

  it("人が座る対戦は、届いたらすぐ描く", () => {
    const state = run(arrived(3, false));
    expect(stepMsOf(state)).toBe(0);
    expect(state.at).toBe(2);
  });

  it("止めているあいだは送らず、進めると止まったまま 1 手進む", () => {
    const paused = run([...arrived(4, true), { t: "pause" }, { t: "tick" }]);
    expect(paused.at).toBe(0);
    expect(run([{ t: "forward" }], paused)).toMatchObject({ at: 1, playing: false, stepped: true });
  });

  it("戻ると止まり、戻った局面の結果は出さない", () => {
    const state = run([...arrived(4, true), { t: "tick" }, { t: "tick" }, { t: "back" }]);
    expect(state).toMatchObject({ at: 1, playing: false, stepped: false });
    expect(run([{ t: "back" }, { t: "back" }], state).at).toBe(0);
  });

  it("届きしだいへ切り替えるか、止めてから届きしだいで再生すると、最後に届いた局面へ行く", () => {
    const waiting = run(arrived(4, true));
    expect(run([{ t: "speed", stepMs: 0 }], waiting).at).toBe(3);
    const paused = run([{ t: "pause" }, { t: "speed", stepMs: 0 }], waiting);
    expect(paused.at).toBe(0);
    expect(run([{ t: "play" }], paused).at).toBe(3);
  });

  it("繋ぎ直して同じ局面がもう一度届いても、局面を増やさない", () => {
    const state = run([...arrived(2, true), { t: "arrive", frame: frame(1, true) }]);
    expect(state.frames).toHaveLength(2);
  });

  it("最新へ飛ぶと再生に戻り、飛んだ先の結果は出さない", () => {
    const state = run([...arrived(4, true), { t: "pause" }, { t: "latest" }]);
    expect(state).toMatchObject({ at: 3, playing: true, stepped: false });
  });
});
