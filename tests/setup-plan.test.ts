/** 対戦準備のバトル場とベンチを、両座席が同時に出す（`docs/spec/battle-server.md` 2.4 節）。 */

import { describe, expect, it } from "vitest";
import { legalMoves, type Move, type Player } from "../src/engine.js";
import { toRecord } from "../src/log.js";
import {
  concede,
  setupViewFor,
  submitMove,
  submitSetup,
  toMove,
  type Match,
} from "../src/match.js";
import { replay } from "../src/replay.js";
import { ensureCards, newMatch } from "./helpers.js";

/** 両座席とも、準備をまとめて出せるところから始まる対戦。マリガンの追加ドローがあると始まらない。 */
function matchReadyForPlans(prefix: string): Match {
  ensureCards();
  for (let attempt = 0; attempt < 50; attempt++) {
    const match = newMatch(`${prefix}-${attempt}`);
    const views = [setupViewFor(match, 0), setupViewFor(match, 1)];
    if (views.every((view) => view?.kind === "choose" && view.bench.length >= 2)) return match;
  }
  throw new Error(`両座席ともまとめて出せる開始局面が見つからない: ${prefix}`);
}

/**
 * 片方だけ最初の手札にたねが無く、1 度のマリガンでたねが来る対戦。どちらになるかは seed で決まるので、
 * 同じ nonce の対戦で先に確かめてから返す。
 */
function oneSidedMulligan(prefix: string): { match: Match; ahead: Player; lacker: Player } {
  ensureCards();
  for (let attempt = 0; attempt < 200; attempt++) {
    const nonce = `${prefix}-${attempt}`;
    const probe = newMatch(nonce);
    const lacking = ([0, 1] as Player[]).filter(
      (seat) => probe.state.players[seat].markers.noBasicDeclared,
    );
    if (lacking.length !== 1) continue;
    const lacker = lacking[0]!;
    const ahead = (1 - lacker) as Player;
    const plan = planOf(probe, ahead);
    submitSetup(probe, ahead, plan.active, plan.bench, 0);
    if (setupViewFor(probe, lacker)?.kind !== "choose") continue;
    return { match: newMatch(nonce), ahead, lacker };
  }
  throw new Error(`片方だけが 1 度引き直す対戦が見つからない: ${prefix}`);
}

/** バトル場に 1 枚、残りのたねからベンチに 1 枚。 */
function planOf(match: Match, seat: Player): { active: string; bench: string[] } {
  const view = setupViewFor(match, seat);
  if (view?.kind !== "choose") throw new Error("まとめて出せる局面ではない");
  const active = view.active[0] as string;
  const bench = view.bench.filter((id) => id !== active).slice(0, 1);
  return { active, bench };
}

function defIdOf(match: Match, seat: Player, instanceId: string): string | undefined {
  return match.state.players[seat].hand.find((card) => card.instanceId === instanceId)?.defId;
}

describe("対戦準備をまとめて出す", () => {
  it("手番でない座席の答えも受け取り、両座席がそろった時点で準備を終える", () => {
    const match = matchReadyForPlans("plan-both");
    const first = toMove(match) as Player;
    const second = (1 - first) as Player;
    const plans = [planOf(match, 0), planOf(match, 1)];
    const wanted = ([0, 1] as Player[]).map((seat) => ({
      active: defIdOf(match, seat, plans[seat]!.active),
      bench: plans[seat]!.bench.map((id) => defIdOf(match, seat, id)),
    }));

    // 後攻が先に出す。先攻がバトル場を選ぶ前なので、局面は動かない。
    const early = submitSetup(match, second, plans[second]!.active, plans[second]!.bench, 1_000);
    expect(early).toEqual({ ok: true, events: [] });
    expect(match.version).toBe(0);
    expect(setupViewFor(match, second)?.kind).toBe("submitted");

    const late = submitSetup(match, first, plans[first]!.active, plans[first]!.bench, 2_000);
    expect(late.ok).toBe(true);
    expect(match.state.phase).not.toBe("setup");
    expect(match.setupPlans).toEqual([null, null]);
    for (const seat of [0, 1] as Player[]) {
      const side = match.state.players[seat];
      expect(side.active?.stack.at(-1)?.defId).toBe(wanted[seat]!.active);
      const benched = side.bench.flatMap((pokemon) =>
        pokemon === null ? [] : [pokemon.stack.at(-1)?.defId],
      );
      expect(benched).toEqual(wanted[seat]!.bench);
      expect(setupViewFor(match, seat)).toBeNull();
    }
  });

  it("預かった答えはエンジンの順に記録され、その記録を再生できる", () => {
    const match = matchReadyForPlans("plan-replay");
    const first = toMove(match) as Player;
    const second = (1 - first) as Player;
    const plans = [planOf(match, 0), planOf(match, 1)];
    submitSetup(match, second, plans[second]!.active, plans[second]!.bench, 1_500);
    submitSetup(match, first, plans[first]!.active, plans[first]!.bench, 4_000);

    const players = match.moves.map((logged) => logged.move.player);
    expect(players.slice(0, 2)).toEqual([first, second]);
    // 考えた時間は、まとめて出した答えの最初の 1 手に載る。
    const elapsed = match.moves.map((logged) => logged.elapsedMs);
    expect(elapsed.slice(0, 2)).toEqual([4_000, 1_500]);

    concede(match, first, 5_000);
    const result = replay(toRecord(match));
    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(match.moves.length);
  });

  it("番が来ていない座席の時計は、先に出した答えのぶんを引かない", () => {
    const match = matchReadyForPlans("plan-clock");
    const first = toMove(match) as Player;
    const second = (1 - first) as Player;
    const bank = match.clocks[second].bankMs;
    const plan = planOf(match, second);
    // 1 手の猶予を大きく越えてから出しても、そのあいだ後攻の時計は流れていない。
    submitSetup(match, second, plan.active, plan.bench, 10 * 60_000);
    const own = planOf(match, first);
    submitSetup(match, first, own.active, own.bench, 10 * 60_000);
    expect(match.clocks[second].bankMs).toBe(bank);
    expect(match.clocks[first].bankMs).toBeLessThan(bank);
  });

  it("手番側が 1 手ずつ答えても、預かった相手の答えはその順番で流れる", () => {
    const match = matchReadyForPlans("plan-step");
    const first = toMove(match) as Player;
    const second = (1 - first) as Player;
    const plan = planOf(match, second);
    submitSetup(match, second, plan.active, plan.bench, 0);

    while (match.state.phase === "setup") {
      expect(toMove(match)).toBe(first);
      const move = legalMoves(match.state)[0] as Move;
      expect(submitMove(match, first, match.version, move, 0).ok).toBe(true);
    }
    const benched = match.state.players[second].bench.filter((pokemon) => pokemon !== null);
    expect(benched).toHaveLength(plan.bench.length);
  });

  it("通らない答えは預からず、局面も変えない", () => {
    const match = matchReadyForPlans("plan-reject");
    const seat = toMove(match) as Player;
    const view = setupViewFor(match, seat);
    if (view?.kind !== "choose") throw new Error("まとめて出せる局面ではない");
    const opponentCard = match.state.players[(1 - seat) as Player].hand[0]!.instanceId;
    const notBasic = match.state.players[seat].hand.find(
      (card) => !view.bench.includes(card.instanceId) && !view.active.includes(card.instanceId),
    )!.instanceId;
    const cases: [string, string[]][] = [
      [opponentCard, []],
      [view.active[0]!, [view.active[0]!]],
      [view.active[0]!, [notBasic]],
      [notBasic, []],
    ];
    for (const [active, bench] of cases) {
      expect(submitSetup(match, seat, active, bench, 0)).toEqual({
        ok: false,
        reason: "illegal-move",
      });
      expect(match.setupPlans[seat]).toBeNull();
      expect(match.version).toBe(0);
    }
  });

  it("出した答えは 1 度きりで、準備の外では受け取らない", () => {
    const match = matchReadyForPlans("plan-once");
    const first = toMove(match) as Player;
    const second = (1 - first) as Player;
    const plans = [planOf(match, 0), planOf(match, 1)];
    expect(submitSetup(match, second, plans[second]!.active, plans[second]!.bench, 0).ok).toBe(
      true,
    );
    const again = submitSetup(match, second, plans[second]!.active, plans[second]!.bench, 0);
    expect(again).toEqual({ ok: false, reason: "not-your-turn" });

    submitSetup(match, first, plans[first]!.active, plans[first]!.bench, 0);
    expect(match.state.phase).not.toBe("setup");
    // 手番の座席には、番でないとは返さない。
    const mover = toMove(match) as Player;
    expect(submitSetup(match, mover, plans[mover]!.active, plans[mover]!.bench, 0)).toEqual({
      ok: false,
      reason: "illegal-move",
    });
    const other = (1 - mover) as Player;
    expect(submitSetup(match, other, plans[other]!.active, plans[other]!.bench, 0)).toEqual({
      ok: false,
      reason: "not-your-turn",
    });
  });

  it("引き直す座席には、引き直すまで候補を出さず、見せた手札を両座席に残す", () => {
    const { match, ahead, lacker } = oneSidedMulligan("plan-mulligan");
    expect(setupViewFor(match, lacker)).toBeNull();
    expect(
      submitSetup(match, lacker, match.state.players[lacker].hand[0]!.instanceId, [], 0),
    ).toEqual({
      ok: false,
      reason: "not-your-turn",
    });

    // たねのある側の答えは、相手のマリガンを待たずに流れる。
    const plan = planOf(match, ahead);
    const outcome = submitSetup(match, ahead, plan.active, plan.bench, 10_000);
    expect(outcome.ok && outcome.events.length > 0).toBe(true);
    expect(match.mulligans.map((reveal) => reveal.player)).toEqual([lacker]);
    const view = setupViewFor(match, lacker);
    if (view?.kind !== "choose") throw new Error("引き直したあとにまとめて出せない");
    const hand = match.state.players[lacker].hand.map((card) => card.instanceId);
    expect(view.active.every((id) => hand.includes(id))).toBe(true);
  });

  it("対戦の開始でおたがいに引き直したときも、見せた手札が残る", () => {
    ensureCards();
    let match: Match | undefined;
    for (let attempt = 0; attempt < 400 && match === undefined; attempt++) {
      const candidate = newMatch(`plan-both-mulligan-${attempt}`);
      if (candidate.mulligans.length >= 2) match = candidate;
    }
    if (match === undefined) throw new Error("おたがいに引き直して始まる対戦が見つからない");
    // おたがいのマリガンは両者が同時に見せる。
    expect(new Set(match.mulligans.slice(0, 2).map((reveal) => reveal.player))).toEqual(
      new Set([0, 1]),
    );
  });

  it("引き直した座席の考えた時間は、引き直したときから測る", () => {
    const { match, ahead, lacker } = oneSidedMulligan("plan-mulligan-time");
    const plan = planOf(match, ahead);
    submitSetup(match, ahead, plan.active, plan.bench, 10_000);
    const own = planOf(match, lacker);
    const before = match.moves.length;
    expect(submitSetup(match, lacker, own.active, own.bench, 25_000).ok).toBe(true);
    const planned = match.moves.slice(before).find((logged) => logged.move.player === lacker);
    expect(planned?.elapsedMs).toBe(15_000);
  });

  it("追加ドローは枚数を選んで 1 手ずつ答え、そのあとのベンチもまとめて出さない", () => {
    const { match, ahead, lacker } = oneSidedMulligan("plan-mulligan-bonus");
    for (const seat of [ahead, lacker]) {
      const plan = planOf(match, seat);
      expect(submitSetup(match, seat, plan.active, plan.bench, 0).ok).toBe(true);
    }
    expect(match.state.choices.at(-1)?.kind).toBe("setup-bonus-draw");
    expect(toMove(match)).toBe(ahead);
    expect(setupViewFor(match, ahead)).toBeNull();
    const one = legalMoves(match.state).find(
      (move) => move.type === "AnswerChoice" && move.answer.kind === "bonusDrawCount",
    ) as Move;
    expect(submitMove(match, ahead, match.version, one, 0).ok).toBe(true);
    expect(setupViewFor(match, ahead)).toBeNull();
  });
});
