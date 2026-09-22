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
import type { Player } from "../src/engine.js";
import { clockView, legalMovesFor, toMove, viewFor, type Match } from "../src/match.js";
import { ensureCards, hiddenInstanceIds, newMatch, playToEnd } from "./helpers.js";

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
