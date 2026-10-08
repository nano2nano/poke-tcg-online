import { describe, expect, it } from "vitest";
import type { Move } from "../../src/engine.js";
import type { MoveContext } from "./describe-move.js";
import { groupMoves } from "./move-groups.js";

const context: MoveContext = { view: null, cards: {} };

function buttons(moves: Move[]) {
  return moves.map((move, index) => ({ move, key: String(index), label: `手 ${index}` }));
}

describe("groupMoves", () => {
  it("種類の順に分け、種類の中はエンジンが出した順に並べる", () => {
    const groups = groupMoves(
      buttons([
        { type: "Attack", player: 0, attackIndex: 0 },
        { type: "UseAbility", player: 0, source: "p1", abilityIndex: 0 },
        { type: "PlayTrainer", player: 0, cardInstanceId: "c1" },
        { type: "UseAbility", player: 0, source: "p2", abilityIndex: 0 },
      ]),
      context,
    );
    expect(groups.map(({ title, entries }) => [title, entries.map(({ key }) => key)])).toEqual([
      ["手札から出す・使う", ["2"]],
      ["特性", ["1", "3"]],
      ["ワザ（使うと番が終わる）", ["0"]],
    ]);
  });

  it("先だけが違う手を 1 つにまとめ、押したポケモンで指す手を引けるようにする", () => {
    const toBench = {
      type: "AttachEnergy",
      player: 0,
      cardInstanceId: "e1",
      target: "p2",
    } as const;
    const [group] = groupMoves(
      buttons([
        { type: "AttachEnergy", player: 0, cardInstanceId: "e1", target: "p1" },
        toBench,
        { type: "AttachEnergy", player: 0, cardInstanceId: "e2", target: "p1" },
      ]),
      context,
    );
    const [bundled, single] = group!.entries;
    expect([bundled!.label, single!.label]).toEqual(["手札の e1 をつける（手張り）…", "手 2"]);
    expect(bundled!.pick?.moves.get("p2")).toBe(toBench);
    expect(single!.button?.move.type).toBe("AttachEnergy");
  });

  it("にげる手は先が 1 匹でもまとめるが、先のポケモンを押して出した手ならそのまま指す", () => {
    const retreat = buttons([{ type: "Retreat", player: 0, to: "p2" }]);
    const [entry] = groupMoves(retreat, context)[0]!.entries;
    expect(entry!.label).toBe("にげる…");
    expect(entry!.button).toBeUndefined();
    expect([...entry!.pick!.moves.keys()]).toEqual(["p2"]);

    const [chosen] = groupMoves(retreat, context, "p2")[0]!.entries;
    expect(chosen!.pick).toBeUndefined();
    expect(chosen!.label).toBe("手 0");
  });
});
