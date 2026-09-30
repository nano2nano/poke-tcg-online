/** 画面が持つ対戦の状態（`web/lib/match-state.ts`）。 */

import { describe, expect, it } from "vitest";
import type { Player } from "../../src/engine.js";
import {
  answerDestinationsFor,
  attacksFor,
  clockView,
  deckPlacementFor,
  legalMovesFor,
  revealedDeckFor,
  setupViewFor,
  spectatorViewFor,
  viewFor,
  type Match,
} from "../../src/match.js";
import type { ReplayFrame } from "../../src/history.js";
import type {
  DeltaMessage,
  EndedMessage,
  SpectatorSyncMessage,
  SyncMessage,
} from "../../src/protocol.js";
import {
  initialReplayState,
  initialSeatState,
  initialWatchState,
  replayReducer,
  seatReducer,
  setupOffer,
  watchReducer,
} from "./match-state.js";
import { ensureCards, newMatch } from "../../tests/helpers.js";

/**
 * 座席 0 がバトル場とベンチをまとめて選べる、準備の局面。ベンチの候補は 2 枚以上あり、
 * バトル場の候補には、ベンチの先頭 2 枚と別のカードがある。
 */
function matchInSetup(): Match {
  ensureCards();
  for (let attempt = 0; attempt < 50; attempt++) {
    const match = newMatch(`match-state-${attempt}`);
    const setup = setupViewFor(match, 0);
    if (setup?.kind !== "choose" || setup.bench.length < 2) continue;
    const picked = new Set(setup.bench.slice(0, 2));
    if (setup.active.some((id) => !picked.has(id))) return match;
  }
  throw new Error("条件に合う開始局面が見つからない");
}

/** サーバが座席へ送る `sync` と同じ組み立て（`src/hub.ts`）。 */
function syncOf(match: Match, seat: Player): SyncMessage {
  return {
    t: "sync",
    matchId: match.matchId,
    seat,
    stateVersion: match.version,
    view: viewFor(match, seat),
    legalMoves: legalMovesFor(match, seat),
    setup: setupViewFor(match, seat),
    deckPlacement: deckPlacementFor(match, seat),
    answerDestinations: answerDestinationsFor(match, seat),
    revealedDeck: revealedDeckFor(match, seat),
    attacks: attacksFor(match, seat),
    mulligans: match.mulligans,
    firstPlayer: match.firstPlayer,
    clock: clockView(match, 0),
    seedCommit: match.seedCommitment.commit,
    spectatorToken: match.spectatorToken,
  };
}

/** 準備の外の delta と同じく、見せた手札を運ばない。 */
function deltaOf(sync: SyncMessage): DeltaMessage {
  return {
    t: "delta",
    stateVersion: sync.stateVersion + 1,
    events: [],
    view: sync.view,
    legalMoves: sync.legalMoves,
    setup: sync.setup,
    deckPlacement: sync.deckPlacement,
    answerDestinations: sync.answerDestinations,
    revealedDeck: sync.revealedDeck,
    attacks: sync.attacks,
    clock: sync.clock,
  };
}

function endedOf(sync: SyncMessage): EndedMessage {
  return {
    t: "ended",
    matchResult: { kind: "concede", winner: 1, conceded: 0 },
    outcome: null,
    seed: "0".repeat(32),
    seedNonce: "nonce",
    seedShares: [null, null],
    view: sync.view,
  };
}

function chooseOffer(sync: SyncMessage) {
  if (sync.setup?.kind !== "choose") throw new Error("準備の候補が無い");
  return sync.setup;
}

describe("座席の状態", () => {
  const match = matchInSetup();
  const sync = syncOf(match, 0);
  const offer = chooseOffer(sync);
  const [first, second] = offer.bench as [string, string];
  // 同じたねはバトル場とベンチの両方の候補に入る。ベンチに選ぶものと別のカードをバトル場に選ぶ。
  const active = offer.active.find((id) => id !== first && id !== second)!;
  const seated = seatReducer(initialSeatState(0), sync);

  it("sync で局面と対戦の値をそろえる", () => {
    expect(seated.view).toBe(sync.view);
    expect(seated.matchId).toBe(match.matchId);
    expect(seated.spectatorToken).toBe(match.spectatorToken);
    expect(setupOffer(seated)).toBe(sync.setup);
  });

  it("準備の選びかけは、同じ候補の局面が届き直しても残る", () => {
    let state = seatReducer(seated, { t: "toggle-bench", instanceId: first });
    state = seatReducer(state, { t: "choose-active", instanceId: active });
    state = seatReducer(state, syncOf(match, 0));
    expect(state.setupDraft).toEqual({ active, bench: [first] });
  });

  it("バトル場に選んだカードは、ベンチの選びかけから外す", () => {
    // ベンチの候補はたねなので、バトル場の候補にも入っている。
    expect(offer.active).toContain(first);
    let state = seatReducer(seated, { t: "toggle-bench", instanceId: first });
    state = seatReducer(state, { t: "choose-active", instanceId: first });
    expect(state.setupDraft).toMatchObject({ active: first, bench: [] });
  });

  it("ベンチは空きの数までしか選べない", () => {
    const narrow = seatReducer(initialSeatState(0), {
      ...sync,
      setup: { ...offer, benchSlots: 1 },
    });
    const full = seatReducer(narrow, { t: "toggle-bench", instanceId: first });
    expect(seatReducer(full, { t: "toggle-bench", instanceId: second })).toBe(full);
    expect(seatReducer(full, { t: "toggle-bench", instanceId: first }).setupDraft.bench).toEqual(
      [],
    );
  });

  it("候補から消えたカードは、選びかけから外す", () => {
    const state = seatReducer(seated, { t: "toggle-bench", instanceId: first });
    const next = seatReducer(state, {
      ...sync,
      setup: { ...offer, bench: offer.bench.filter((id) => id !== first) },
    });
    expect(next.setupDraft.bench).toEqual([]);
  });

  it("delta が見せた手札を運ばなければ、前に届いたものを残す", () => {
    const withReveal = seatReducer(initialSeatState(0), {
      ...sync,
      mulligans: [{ player: 1, cards: [] }],
    });
    const next = seatReducer(withReveal, deltaOf(sync));
    expect(next.mulligans).toBe(withReveal.mulligans);
    expect(next.stateVersion).toBe(sync.stateVersion + 1);
  });

  it("決着したら、指せる手と選びかけと観戦トークンを捨てる", () => {
    const chosen = seatReducer(seated, { t: "choose-active", instanceId: active });
    const ended = seatReducer(chosen, endedOf(sync));
    expect(ended.ended?.matchResult).toEqual({ kind: "concede", winner: 1, conceded: 0 });
    expect(ended.legalMoves).toBeNull();
    expect(ended.spectatorToken).toBeNull();
    expect(setupOffer(ended)).toBeNull();
    expect(ended.setupDraft).toEqual({ active: null, bench: [] });
    expect(seatReducer(ended, { t: "toggle-bench", instanceId: first })).toBe(ended);
  });

  it("前の状態と受け取ったメッセージを書き換えない", () => {
    const before = structuredClone(seated);
    const message = structuredClone(sync);
    seatReducer(seated, message);
    seatReducer(seated, { t: "toggle-bench", instanceId: first });
    seatReducer(seated, endedOf(message));
    expect(seated).toEqual(before);
    expect(message).toEqual(sync);
  });

  it("状態を変えないメッセージには、同じ状態を返す", () => {
    for (const message of [
      { t: "pong" },
      { t: "pending" },
      { t: "reject", reason: "stale-version", stateVersion: 0 },
      { t: "error", message: "断った" },
    ] as const) {
      expect(seatReducer(seated, message)).toBe(seated);
    }
  });
});

describe("観戦の状態", () => {
  const match = matchInSetup();
  const sync: SpectatorSyncMessage = {
    t: "spectator-sync",
    stateVersion: match.version,
    view: spectatorViewFor(match),
    firstPlayer: match.firstPlayer,
    clock: clockView(match, 0),
    seats: [
      { displayName: "あ", rating: 1500 },
      { displayName: "い", rating: null },
    ],
  };

  it("delta は座席の名前と先攻を持たないので、sync で届いたものを残す", () => {
    const synced = watchReducer(initialWatchState(), sync);
    const next = watchReducer(synced, {
      t: "spectator-delta",
      stateVersion: sync.stateVersion + 1,
      events: [],
      view: sync.view,
      clock: sync.clock,
    });
    expect(next.seats).toBe(sync.seats);
    expect(next.firstPlayer).toBe(match.firstPlayer);
    expect(next.stateVersion).toBe(sync.stateVersion + 1);
  });

  it("決着を持つ", () => {
    const ended = watchReducer(watchReducer(initialWatchState(), sync), {
      t: "spectator-ended",
      matchResult: { kind: "normal", winner: null },
      outcome: null,
      view: sync.view,
    });
    expect(ended.ended?.matchResult).toEqual({ kind: "normal", winner: null });
  });
});

describe("リプレイの状態", () => {
  const match = matchInSetup();
  const views: ReplayFrame["views"] = [viewFor(match, 0), viewFor(match, 1)];
  const frameAt = (ply: number, divergedAt: number | null = null): ReplayFrame => ({
    matchId: match.matchId,
    ply,
    moveCount: 10,
    views,
    playedMove: null,
    beforeViews: null,
    events: [[], []],
    engineCommitDiffers: false,
    divergedAt,
  });
  const opened = initialReplayState({ matchId: match.matchId, seat: 0, moveCount: 10 });

  it("頼む手数は 0 から辿れる上限までに収める", () => {
    expect(replayReducer(opened, { t: "ask", ply: -1 }).wanted).toBe(0);
    expect(replayReducer(opened, { t: "ask", ply: 11 }).wanted).toBe(10);
  });

  it("あとから出した問い合わせに追い越された応答では描かない", () => {
    const one = replayReducer(opened, { t: "ask", ply: 1 });
    const two = replayReducer(one, { t: "ask", ply: 2 });
    expect(replayReducer(two, { t: "frame", asked: one.asked, frame: frameAt(1) })).toBe(two);
    const drawn = replayReducer(two, { t: "frame", asked: two.asked, frame: frameAt(2) });
    expect(drawn).toMatchObject({ ply: 2, wanted: 2 });
    expect(drawn.frame?.ply).toBe(2);
  });

  it("失敗したら、頼んだ手数を描けている手数へ戻す。追い越された失敗では戻さない", () => {
    const one = replayReducer(opened, { t: "ask", ply: 1 });
    expect(replayReducer(one, { t: "failed", asked: one.asked }).wanted).toBe(0);
    const two = replayReducer(one, { t: "ask", ply: 2 });
    expect(replayReducer(two, { t: "failed", asked: one.asked })).toBe(two);
  });

  it("再現できない地点が分かったら、辿れる上限をそこまで下げる", () => {
    const last = replayReducer(opened, { t: "ask", ply: 10 });
    const drawn = replayReducer(last, { t: "frame", asked: last.asked, frame: frameAt(4, 4) });
    expect(drawn).toMatchObject({ ply: 4, wanted: 4, moveCount: 4 });
    expect(replayReducer(drawn, { t: "ask", ply: 10 }).wanted).toBe(4);
  });
});
