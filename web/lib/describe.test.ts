import { describe, expect, it } from "vitest";
import type { Player, PlayerEvent, SpectatorView } from "../../src/engine.js";
import type { CardTable } from "./cards.js";
import {
  cardSubtitle,
  describeEvents,
  describeSummary,
  noticesToShow,
  rejectText,
  seatClockText,
  seatEndText,
} from "./describe.js";

const cards: CardTable = {
  pikachu: { name: "ピカチュウ", kind: "pokemon", hp: 60, attacks: ["でんきショック"] },
  nanjamo: { name: "ナンジャモ", kind: "trainer", trainerKind: "supporter" },
};
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
    const notices = describeEvents([prize, prize], [after, null], who, cards);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("4");
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

  it("続けて引いたカードは 1 つに畳み、枚数と引かせたカードを書く", () => {
    const source = { defId: "nanjamo", instanceId: "n1", label: "ナンジャモ" };
    const drawn = event({ kind: "card-drawn-hidden", player: 1, count: 1, actor: 0, source });
    const notices = describeEvents([drawn, drawn, drawn], [null], who, cards);
    expect(notices.map((notice) => notice.text)).toEqual(["いがカードを 3 枚引いた（ナンジャモ）"]);
    // 引かせたのは座席 0 なので、座席 1 の画面にも出す。
    expect(noticesToShow(notices, 1)).toHaveLength(1);
  });

  it("自分でしたことは座席の画面の結果に出さず、記録には残す", () => {
    const view = board([{ active: pokemon("p0") }, {}]);
    const notices = describeEvents(
      [
        event({ kind: "trainer-played", player: 0, card: { instanceId: "c1", defId: "nanjamo" } }),
        event({ kind: "attack-declared", player: 0, sourceInPlay: "p0", attackIndex: 0 }),
      ],
      [view],
      who,
      cards,
    );
    expect(notices.map((notice) => notice.text)).toEqual([
      "あがナンジャモを使った",
      "あのピカチュウが「でんきショック」を使った",
    ]);
    expect(notices.map((notice) => notice?.card)).toEqual(["nanjamo", "pikachu"]);
    expect(noticesToShow(notices, 0)).toEqual([]);
    expect(noticesToShow(notices, 1)).toHaveLength(2);
  });

  it("進化は、進化する前の名前を適用前の盤面から引く", () => {
    const before = board([{ active: pokemon("p0") }, {}]);
    const after = board([
      { active: { inPlayId: "p0", stack: [{ instanceId: "c2", defId: "raichu" }] } },
      {},
    ]);
    const [notice] = describeEvents(
      [
        event({
          kind: "pokemon-evolved",
          player: 0,
          target: "p0",
          card: { instanceId: "c2", defId: "raichu" },
          from: { kind: "hand", player: 0 },
        }),
      ],
      [after, before],
      who,
      cards,
    );
    expect(notice?.text).toBe("あのピカチュウがraichuに進化した");
  });

  it("見せる文の無いイベントは落とす", () => {
    expect(describeEvents([event({ kind: "pokemon-check-started" })], [null], who, cards)).toEqual(
      [],
    );
  });
});

describe("seatEndText", () => {
  it("エンジンが決めた勝敗は、決まった理由を添える", () => {
    const ended = {
      matchResult: { kind: "normal", winner: 0 },
      outcome: { winner: 0, reason: "prizes-taken" },
    } as const;
    expect(seatEndText(ended, 0)).toBe("勝ち（サイドを取りきった）");
    expect(seatEndText(ended, 1)).toBe("負け（サイドを取りきった）");
  });

  it("投了は、どちらが投了したかではなく自分の勝ち負けで出す", () => {
    const ended = {
      matchResult: { kind: "concede", winner: 1, conceded: 0 },
      outcome: null,
    } as const;
    expect(seatEndText(ended, 0)).toBe("投了により 負け");
  });

  it("エンジンの勝敗が無ければ、空の括弧を付けない", () => {
    const ended = { matchResult: { kind: "normal", winner: 0 }, outcome: null } as const;
    expect(seatEndText(ended, 0)).toBe("勝ち");
  });
});

describe("seatClockText", () => {
  it("決着した局面では、相手が考えているとは出さない", () => {
    const clock = {
      bankMs: [60_000, 60_000] as [number, number],
      moveRemainingMs: null,
      toMove: null,
    };
    expect(seatClockText(clock, 0)).not.toContain("相手が考えています");
  });
});

describe("rejectText", () => {
  it("断った理由を言葉で出す", () => {
    expect(rejectText("stale-version")).toBe("手が通りませんでした（盤面が先に進んでいました）");
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

describe("describeSummary", () => {
  it("相手、結果と決着の仕方、手数を 1 行にする", () => {
    const line = describeSummary({
      matchId: "m",
      startedAt: "2026-09-28T00:00:00Z",
      endedAt: "2026-09-28T00:10:00Z",
      seat: 0,
      opponentName: "あいて",
      outcome: "win",
      matchResult: { kind: "concede", winner: 0, conceded: 1 },
      moveCount: 12,
    });
    expect(line).toContain("あいて と 勝ち（投了） 12 手");
  });
});
