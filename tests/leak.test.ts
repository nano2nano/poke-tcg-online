/**
 * 座席へ配る値が非公開の情報を含まないことの機械検査（`docs/spec/battle-server.md` 4.2 節）。
 *
 * エンジンには `checkNoLeak`（隠れたゾーンをかき混ぜても合法手が変わらない）と
 * `checkChoiceVisibility`（`Choice` の候補が owner の見えるゾーンに限る）がある。
 * この検査はそれらの外側、**実際に配信される payload そのもの**に掛ける。
 * エンジンのコア SPEC §9.1 が「射影を必ず通す規律はサーバ側の責務」と書いた部分を、
 * 機械で守る形にしたものである。
 */

import { describe, expect, it } from "vitest";
import type { Player, PlayerEvent, Viewer } from "../src/engine.js";
import {
  clockView,
  eventsFor,
  legalMovesFor,
  spectatorViewFor,
  toMove,
  viewFor,
  type Match,
} from "../src/match.js";
import {
  concealedInstanceIds,
  ensureCards,
  hiddenInstanceIds,
  newMatch,
  playToEnd,
} from "./helpers.js";

/**
 * 座席へ実際に出る値をそのまま組み立てる。`hub.ts` の `syncFor` と同じ 4 つで、
 * 片方だけ直しても気づけるよう、**中身ではなく組み合わせ**を検査の対象にする。
 */
function seatPayload(match: Match, seat: Player): string {
  return JSON.stringify({
    view: viewFor(match, seat),
    legalMoves: legalMovesFor(match, seat),
    clock: clockView(match, 0),
  });
}

describe("座席へ配る値", () => {
  it("隠れているカードのインスタンス ID を 1 つも含まない", () => {
    ensureCards();
    for (const nonce of ["leak-1", "leak-2", "leak-3"]) {
      const match = newMatch(nonce);
      const leaks: string[] = [];
      playToEnd(match, 20260921, {
        inspect: (current, seat) => {
          const payload = seatPayload(current, seat);
          for (const instanceId of hiddenInstanceIds(current.state, seat)) {
            // JSON の中ではインスタンス ID は必ず引用符で囲まれた値として現れる。
            // 引用符ごと探さないと `p0-1` が `p0-12` に当たる。
            if (payload.includes(`"${instanceId}"`)) {
              leaks.push(`${nonce} 座席${seat} 手${current.version}: ${instanceId}`);
            }
          }
        },
      });
      expect(leaks).toEqual([]);
    }
  });

  it("自分が持ち主でない Choice の選択肢を見せない", () => {
    ensureCards();
    const match = newMatch("leak-prompt");
    const leaks: string[] = [];
    playToEnd(match, 7717, {
      inspect: (current, seat) => {
        for (const choice of viewFor(current, seat).choices) {
          if (choice.owner !== seat && choice.prompt !== null) {
            leaks.push(`座席${seat} が ${choice.owner} の選択肢を見ている`);
          }
        }
      },
    });
    expect(leaks).toEqual([]);
  });

  it("合法手は手番側の座席にだけ入る", () => {
    ensureCards();
    const match = newMatch("leak-legal");
    const leaks: string[] = [];
    playToEnd(match, 31337, {
      inspect: (current, seat) => {
        const mover = toMove(current);
        const legal = legalMovesFor(current, seat);
        if (mover === seat && legal === null) leaks.push(`手番側の座席${seat}に合法手が無い`);
        if (mover !== seat && legal !== null) leaks.push(`手番でない座席${seat}に合法手が入った`);
      },
    });
    expect(leaks).toEqual([]);
  });
});

/** 観戦者へ実際に出る値。`hub.ts` の `spectatorSyncFor` と同じ組み合わせにする。 */
function spectatorPayload(match: Match): string {
  return JSON.stringify({ view: spectatorViewFor(match), clock: clockView(match, 0) });
}

describe("観戦者へ配る値", () => {
  it("どちらの座席の隠れているカードのインスタンス ID も含まない", () => {
    ensureCards();
    for (const nonce of ["watch-1", "watch-2", "watch-3"]) {
      const match = newMatch(nonce);
      const leaks: string[] = [];
      playToEnd(match, 20260923, {
        inspect: (current, seat) => {
          // 手番ごとに 2 回呼ばれるので、観戦者のぶんは片方の座席のときだけ見る。
          if (seat !== 0) return;
          const payload = spectatorPayload(current);
          for (const instanceId of hiddenInstanceIds(current.state, "spectator")) {
            if (payload.includes(`"${instanceId}"`)) {
              leaks.push(`${nonce} 手${current.version}: ${instanceId}`);
            }
          }
        },
      });
      expect(leaks).toEqual([]);
    }
  });

  it("どちらの持ち主の Choice の選択肢も見せない", () => {
    ensureCards();
    const match = newMatch("watch-prompt");
    const leaks: string[] = [];
    playToEnd(match, 7717, {
      inspect: (current) => {
        for (const choice of spectatorViewFor(current).choices) {
          if (choice.prompt !== null) leaks.push(`座席${choice.owner} の選択肢が見えている`);
        }
      },
    });
    expect(leaks).toEqual([]);
  });
});

/**
 * 効果の出所（`EffectSource`）を落として JSON にする。
 *
 * 出所が名指す個体は、効果が公開の事象として起きたことで正体が割れている。自分を手札へ戻す
 * ワザのあとは手札にいるので、落とさないと漏洩でないものを漏洩として数える。
 * 落とすのは 3 欄ちょうどの形に限る。形が変われば偽陽性で落ちる側に倒れ、素通りはしない。
 */
function withoutEffectSources(event: PlayerEvent): string {
  return JSON.stringify(event, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const isEffectSource =
      keys.length === 3 &&
      typeof record.defId === "string" &&
      typeof record.instanceId === "string" &&
      typeof record.label === "string";
    return isEffectSource ? undefined : value;
  });
}

/**
 * **射影の漏れは `view` よりイベントの側で起きる。** ウラのサイドを取った `prize-taken` は、
 * 取ったカードをそのまま運んでいた。そのカードは手札へ入るので、相手に手札の 1 枚が割れていた。
 * `view` だけを見る上の検査はこれを通していた。
 *
 * 規則は「宛先から見て、手の前も後も正体の分からないカードが、その宛先へ配るイベントに載らない」。
 * 公開ゾーンを通ったカード（トラッシュから山札へ戻すなど）は、その時点で正体が見えているので対象にしない。
 * `cards-revealed` のうち、両者へ見せるものと宛先本人へ見せるものは、見せることが効果の目的なので除く。
 */
describe("配るイベント", () => {
  const viewers: Viewer[] = [0, 1, "spectator"];

  it("手の前も後も隠れているカードの正体を、座席にも観戦者にも運ばない", () => {
    ensureCards();
    const leaks: string[] = [];
    let prizesTaken = 0;
    for (const nonce of ["events-1", "events-2", "events-3", "events-4"]) {
      const match = newMatch(nonce);
      playToEnd(match, 4242, {
        applied: (before, current, events) => {
          prizesTaken += events.filter((event) => event.kind === "prize-taken").length;
          for (const viewer of viewers) {
            const after = concealedInstanceIds(current.state, viewer);
            const concealed = [...concealedInstanceIds(before, viewer)].filter((id) =>
              after.has(id),
            );
            for (const event of eventsFor(events, viewer)) {
              if (
                event.kind === "cards-revealed" &&
                (event.audience === "public" || event.player === viewer)
              ) {
                continue;
              }
              const text = withoutEffectSources(event);
              for (const id of concealed) {
                if (text.includes(`"${id}"`)) {
                  leaks.push(`${nonce} 宛先${viewer} 手${current.version}: ${event.kind} ${id}`);
                }
              }
            }
          }
        },
      });
    }
    // サイドを 1 枚も取らない対戦ばかりなら、この検査は何も見ていない。
    expect(prizesTaken).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
  });
});
