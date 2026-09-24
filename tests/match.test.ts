/** 手の受理と決着（`docs/spec/battle-server.md` 2 節）。 */

import { describe, expect, it } from "vitest";
import { legalMoves, type Move, type Player } from "../src/engine.js";
import { MOVE_ALLOWANCE_MS } from "../src/clock.js";
import {
  applyTimeout,
  concede,
  engineOutcome,
  submitMove,
  toMove,
  type Match,
} from "../src/match.js";
import { ensureCards, newMatch, playToEnd } from "./helpers.js";

function firstLegal(match: ReturnType<typeof newMatch>): Move {
  return legalMoves(match.state)[0] as Move;
}

/**
 * 合法手が 2 つ以上ある開始局面。
 *
 * **1 つしか無い局面では、絞り込んだ申告が「全部見せた」と同じ意味になる**ので、
 * 畳み込みと区別が付かない。どの手札が配られるかはシャッフル次第で、nonce を
 * 固定しても乱数を変えれば変わるので、条件を満たすものを探して使う。
 */
function matchWithChoices(prefix: string): ReturnType<typeof newMatch> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const match = newMatch(`${prefix}-${attempt}`);
    if (legalMoves(match.state).length >= 2) return match;
  }
  throw new Error(`合法手が 2 つ以上ある開始局面が見つからない: ${prefix}`);
}

describe("手の受理", () => {
  it("手番でない座席の手を弾き、局面を動かさない", () => {
    ensureCards();
    const match = newMatch("submit-1");
    const mover = toMove(match) as Player;
    const other = (1 - mover) as Player;
    const before = match.version;
    expect(submitMove(match, other, match.version, firstLegal(match), 0)).toEqual({
      ok: false,
      reason: "not-your-turn",
    });
    expect(match.version).toBe(before);
  });

  it("古い stateVersion の手を弾く（二重送信と古い画面を同じ仕組みで止める）", () => {
    ensureCards();
    const match = newMatch("submit-2");
    const mover = toMove(match) as Player;
    const move = firstLegal(match);
    expect(submitMove(match, mover, match.version, move, 0).ok).toBe(true);
    // 同じ手をもう一度、古い版番号で送る。
    expect(submitMove(match, toMove(match) as Player, match.version - 1, move, 0)).toEqual({
      ok: false,
      reason: "stale-version",
    });
  });

  it("合法手に無い手を弾き、対戦を終わらせない", () => {
    ensureCards();
    const match = newMatch("submit-3");
    const mover = toMove(match) as Player;
    const bogus: Move = { type: "EndTurn", player: mover };
    const outcome = submitMove(match, mover, match.version, bogus, 0);
    expect(outcome).toEqual({ ok: false, reason: "illegal-move" });
    expect(match.result).toBeNull();
    expect(toMove(match)).toBe(mover);
  });

  it("1 手ごとに版番号が 1 増え、思考時間が記録される", () => {
    ensureCards();
    const match = newMatch("submit-4", 1_000);
    const mover = toMove(match) as Player;
    submitMove(match, mover, match.version, firstLegal(match), 4_500);
    expect(match.version).toBe(1);
    expect(match.moves).toHaveLength(1);
    expect(match.moves[0]?.elapsedMs).toBe(3_500);
    expect(match.moves[0]?.source).toBe("human");
  });
});

describe("決着", () => {
  it("最後まで指すと勝敗が付き、エンジンの outcome と一致する", () => {
    ensureCards();
    const played = playToEnd(newMatch("finish-1"), 4242);
    expect(played.finished).toBe(true);
    expect(played.match.result?.kind).toBe("normal");
    const outcome = engineOutcome(played.match);
    expect(outcome).not.toBeNull();
    if (played.match.result?.kind === "normal") {
      expect(played.match.result.winner).toBe(outcome?.winner ?? null);
    }
  });

  it("投了は局面を動かさず、エンジンの outcome を付けない", () => {
    ensureCards();
    const match = newMatch("finish-2");
    const version = match.version;
    expect(concede(match, 0, 5_000)).toBe(true);
    expect(match.result).toEqual({ kind: "concede", winner: 1, conceded: 0 });
    expect(engineOutcome(match)).toBeNull();
    expect(match.version).toBe(version);
    expect(toMove(match)).toBeNull();
  });

  it("持ち時間が尽きた座席の負けにし、自動の手を指さない", () => {
    ensureCards();
    const match = newMatch("finish-3");
    const mover = toMove(match) as Player;
    expect(applyTimeout(match, MOVE_ALLOWANCE_MS)).toBe(false);
    const overrun = MOVE_ALLOWANCE_MS + match.clocks[mover].bankMs;
    expect(applyTimeout(match, overrun)).toBe(true);
    expect(match.result).toEqual({
      kind: "timeout",
      winner: 1 - mover,
      timedOut: mover,
    });
    expect(match.moves).toHaveLength(0);
  });

  // 画面が絞り込んだかどうかは再生で作り直せないので、申告をそのまま持つしかない（6.2 節）。
  it("画面が見せた手の申告を、そのまま記録に残す", () => {
    ensureCards();
    const match = newMatch("submit-9");
    // 一部だけ見せた形を作りたいので、合法手が 3 つ以上ある局面まで進める。
    while (legalMoves(match.state).length < 3 && toMove(match) !== null) {
      const seat = toMove(match) as Player;
      expect(submitMove(match, seat, match.version, firstLegal(match), 0).ok).toBe(true);
    }
    const mover = toMove(match) as Player;
    const legal = legalMoves(match.state);
    const before = match.moves.length;

    // 0 番と、合法手の最後の 1 つだけを見せた画面のつもり。
    const shown = [0, legal.length - 1];
    expect(submitMove(match, mover, match.version, legal[0] as Move, 0, shown).ok).toBe(true);
    expect(match.moves[before]?.offered).toEqual(shown);
    expect(match.moves[before]?.candidates).toBe(legal.length);
    expect(match.moves[before]?.chosen).toBe(0);
  });

  it("全部見せた申告と、範囲外の申告を、記録に載せる前に均す", () => {
    ensureCards();
    const all = newMatch("submit-10");
    const moverAll = toMove(all) as Player;
    const everything = legalMoves(all.state).map((_, index) => index);
    expect(submitMove(all, moverAll, all.version, firstLegal(all), 0, everything).ok).toBe(true);
    // 全部見せたなら「絞り込んでいない」と同じなので null へ畳む。
    expect(all.moves[0]?.offered).toBeNull();

    const broken = matchWithChoices("submit-11");
    const moverBroken = toMove(broken) as Player;
    const count = legalMoves(broken.state).length;
    const outcome = submitMove(broken, moverBroken, broken.version, firstLegal(broken), 0, [
      0,
      0,
      -1,
      count + 5,
    ]);
    // 規則の判定には使わない値なので、壊れていても手は通す。
    expect(outcome.ok).toBe(true);
    expect(broken.moves[0]?.offered).toEqual([0]);
  });

  it("決着したあとは手を受け付けない", () => {
    ensureCards();
    const match = newMatch("finish-4");
    concede(match, 0, 0);
    expect(submitMove(match, 1, match.version, firstLegal(match), 0)).toEqual({
      ok: false,
      reason: "match-over",
    });
  });
});

/**
 * 画面の案内（`public/app.js` の `promptText`）は、この順を前提に書いてある。
 * エンジンが順を変えたら、案内も書き直す。
 */
/**
 * 最初の手札で「たねが無い」と伝えた座席の数が `lacking` の対戦を、`count` 個。どうなるかは seed で
 * 決まるので、作ってみて選ぶ。片方だけのときは、1 度のマリガンでたねが来る対戦に限る。
 */
function setupMatches(prefix: string, lacking: number, count: number): Match[] {
  ensureCards();
  const found: Match[] = [];
  for (let attempt = 0; attempt < 400 && found.length < count; attempt++) {
    const nonce = `${prefix}-${attempt}`;
    const match = newMatch(nonce);
    const declared = match.state.players.filter((side) => side.markers.noBasicDeclared).length;
    if (declared !== lacking) continue;
    if (lacking > 0) {
      const probe = newMatch(nonce);
      while (probe.state.phase === "setup") {
        submitMove(probe, toMove(probe) as Player, probe.version, firstLegal(probe), 0);
      }
      if (probe.mulligans.length !== 1) continue;
    }
    found.push(match);
  }
  if (found.length < count) throw new Error(`準備の形が合う対戦が足りない: ${prefix}`);
  return found;
}

describe("対戦準備", () => {
  it("両者にたねがあれば、先攻、後攻の順にバトル場を選び終えてから、ベンチを選ぶ", () => {
    for (const match of setupMatches("setup-order", 0, 3)) {
      const placements: string[] = [];
      while (match.state.phase === "setup") {
        const top = match.state.choices.at(-1);
        if (top?.kind === "setup-place-active" || top?.kind === "setup-place-bench") {
          const side = top.owner === match.state.turnPlayer ? "先攻" : "後攻";
          placements.push(`${top.kind} ${side}`);
        }
        const mover = toMove(match) as Player;
        expect(submitMove(match, mover, match.version, firstLegal(match), 0).ok).toBe(true);
      }
      expect(placements.slice(0, 2)).toEqual([
        "setup-place-active 先攻",
        "setup-place-active 後攻",
      ]);
      expect(placements.slice(2).every((each) => each.startsWith("setup-place-bench"))).toBe(true);
      expect(match.mulligans).toEqual([]);
    }
  });

  /**
   * 公式ルールガイド「G 対戦準備」5.b〜5.d と手順 7。たねのある側は、相手が引き直す前にサイドまで進み、
   * 相手のマリガンが済んでから追加で引く。エンジンがこの順を変えたら、まとめて出す答えの扱いを見直す。
   */
  it("片方だけにたねが無ければ、ある側がベンチまで出してから相手が引き直し、追加ドローは最後に来る", () => {
    for (const match of setupMatches("setup-one-sided", 1, 3)) {
      const lacker = ([0, 1] as Player[]).find(
        (seat) => match.state.players[seat].markers.noBasicDeclared,
      ) as Player;
      const ahead = (1 - lacker) as Player;
      const steps: { kind: string; owner: Player }[] = [];
      let revealsBeforeBonus = -1;
      while (match.state.phase === "setup") {
        const top = match.state.choices.at(-1);
        if (top !== undefined) {
          steps.push({ kind: top.kind, owner: top.owner });
          if (top.kind === "setup-bonus-draw") revealsBeforeBonus = match.mulligans.length;
        }
        const mover = toMove(match) as Player;
        expect(submitMove(match, mover, match.version, firstLegal(match), 0).ok).toBe(true);
      }
      const firstOfLacker = steps.findIndex((step) => step.owner === lacker);
      const bonus = steps.findIndex((step) => step.kind === "setup-bonus-draw");
      expect(steps.slice(0, firstOfLacker).every((step) => step.owner === ahead)).toBe(true);
      expect(steps[0]?.kind).toBe("setup-place-active");
      expect(steps[bonus]?.owner).toBe(ahead);
      expect(steps.slice(firstOfLacker, bonus).every((step) => step.owner === lacker)).toBe(true);
      // 追加で引いたあとは、引いた側のベンチが開き直すだけである。
      expect(
        steps
          .slice(bonus + 1)
          .every((step) => step.owner === ahead && step.kind === "setup-place-bench"),
      ).toBe(true);
      // 引き直した手札は両座席に見せる形で残り、追加ドローより前にそろっている。
      expect(match.mulligans.map((reveal) => reveal.player)).toEqual([lacker]);
      expect(revealsBeforeBonus).toBe(1);
    }
  });
});
