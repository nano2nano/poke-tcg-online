import { describe, expect, it } from "vitest";
import type { Player, PlayerEvent, SpectatorView } from "../../src/engine.js";
import type { CardTable } from "./cards.js";
import { cardSubtitle, describeEvents } from "./describe.js";

const cards: CardTable = { pikachu: { name: "ピカチュウ", kind: "pokemon", hp: 60 } };
const who = (player: Player) => ["あ", "い"][player]!;

function pokemon(inPlayId: string) {
  return { inPlayId, stack: [{ instanceId: `${inPlayId}-card`, defId: "pikachu" }] };
}

/** 文を作るのに読む値だけを持つ盤面。 */
function board(
  players: { active?: ReturnType<typeof pokemon> | null; prizeCount?: number }[],
): SpectatorView {
  return {
    viewer: "spectator",
    players: players.map(({ active = null, prizeCount = 6 }) => ({
      active,
      bench: [],
      prizeCount,
    })),
  } as unknown as SpectatorView;
}

function event(body: object): PlayerEvent {
  return {
    seq: 0,
    turn: 1,
    window: { kind: "turn", player: 0 },
    actor: 0,
    source: null,
    ...body,
  } as PlayerEvent;
}

describe("describeEvents", () => {
  it("続けて取ったサイドは 1 つに畳み、取ったあとの残りの枚数で伝える", () => {
    const after = board([{ prizeCount: 4 }, {}]);
    const prize = event({ kind: "prize-taken-hidden", player: 0, count: 2 });
    const [first, second] = describeEvents([prize, prize], [after, null], who, cards);
    expect(first?.text).toContain("4");
    expect(first?.repeated).toBeUndefined();
    expect(second?.repeated).toBe(true);
  });

  it("きぜつしたポケモンは、適用前の盤面から名前を引く", () => {
    const before = board([{}, { active: pokemon("p1") }]);
    const after = board([{}, {}]);
    const [notice] = describeEvents(
      [event({ kind: "pokemon-knocked-out", player: 1, target: "p1" })],
      [after, before],
      who,
      cards,
    );
    expect(notice?.text).toContain("いのピカチュウ");
  });

  it("ダメカンで浮かべる数字は、実際に増えたダメージにする", () => {
    const view = board([{ active: pokemon("p0") }, {}]);
    const placed = (beforeDamage: number, afterDamage: number) =>
      event({ kind: "damage-counters-placed", target: "p0", count: 3, beforeDamage, afterDamage });
    const [partly, capped] = describeEvents([placed(40, 60), placed(60, 60)], [view], who, cards);
    expect(partly?.hit?.text).toBe("-20");
    expect(capped?.hit).toBeUndefined();
  });

  it("見せないイベントは null にする", () => {
    expect(describeEvents([event({ kind: "pokemon-check-started" })], [null], who, cards)).toEqual([
      null,
    ]);
  });
});

describe("cardSubtitle", () => {
  it("2 枚 1 組のスタジアムは、同じ名前でも左右で面の下の段が違う", () => {
    const half = { name: "伝説の海溝", kind: "trainer", trainerKind: "stadium" } as const;
    const left = cardSubtitle({ ...half, stadiumHalf: "left" });
    const right = cardSubtitle({ ...half, stadiumHalf: "right" });
    expect(left).not.toBe(right);
    expect(left).not.toBe(cardSubtitle(half));
  });
});
