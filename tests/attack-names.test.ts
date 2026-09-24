/**
 * 画面はワザの手の見出しを、`attackIndex` を印刷されたワザの並びに当てて引く
 * （`public/app.js` の `attackName`）。エンジンの宣言できるワザの表が、印刷されたワザを
 * 同じ順で前に並べている間だけ正しい。並べ方が変わったらここで落ちる。
 */

import { describe, expect, it } from "vitest";
import { availableAttacks, type Player } from "../src/engine.js";
import { cardIndex } from "../src/card-index.js";
import { newMatch, playToEnd } from "./helpers.js";

describe("宣言できるワザの表", () => {
  it("印刷されたワザを、印刷の順で前に並べる", () => {
    const checked = new Set<string>();
    for (const nonce of ["a", "b", "c"]) {
      playToEnd(newMatch(`ワザの順-${nonce}`), 7, {
        maxMoves: 600,
        inspect: (match, seat: Player) => {
          const active = match.state.players[seat].active;
          if (active === null) return;
          const top = active.stack[active.stack.length - 1]!;
          const printed = cardIndex()[top.defId]?.attacks ?? [];
          const table = availableAttacks(match.state, active.inPlayId);
          expect(table.slice(0, printed.length).map((attack) => attack.from.label)).toEqual(
            printed,
          );
          checked.add(top.defId);
        },
      });
    }
    // 1 種類のポケモンしか見ていなければ、並べ方の違いに気付けない。
    expect(checked.size).toBeGreaterThan(1);
  });
});
