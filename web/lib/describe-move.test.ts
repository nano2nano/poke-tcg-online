import { describe, expect, it } from "vitest";
import type { ChoiceAnswer, Move, PlayerView } from "../../src/engine.js";
import { cardIndex } from "../../src/card-index.js";
import { attacksFor, toMove, viewFor } from "../../src/match.js";
import { ensureCards, finishSetup, newMatch } from "../../tests/helpers.js";
import type { CardTable } from "./cards.js";
import { readerView } from "./describe.js";
import { choicePrompt, describeMove, replayStatusText } from "./describe-move.js";

const answering = (answer: ChoiceAnswer) =>
  describeMove(
    { type: "AnswerChoice", player: 0, choiceId: "c1", answer },
    { view: null, cards: {} },
  );

describe("describeMove", () => {
  it("特殊状態を選ぶ答えは、特殊状態の名前で出す", () => {
    expect(answering({ kind: "condition", condition: "asleep" })).toBe("ねむり");
  });

  it("HP を当てる答えは、答える HP で出す", () => {
    expect(answering({ kind: "hpGuess", value: 120 })).toBe("HP 120");
  });
});

describe("ワザを使う手", () => {
  it("ベンチのポケモンのワザを使えるようになったら、ワザの名前と、どのポケモンのワザかで出す", () => {
    ensureCards();
    const match = newMatch("describe-move-attack");
    finishSetup(match);
    const player = toMove(match)!;
    const side = match.state.players[player];
    const active = side.active!;
    const lent = active.stack.at(-1)!;
    side.bench[0] = {
      ...active,
      inPlayId: "ベンチのポケモン",
      stack: [{ instanceId: "ベンチのカード", defId: lent.defId }],
    };
    const index = cardIndex();
    // バトル場に出すと、ベンチのポケモンのワザも宣言できるようになるポケモンを、カードプールから探す。
    const lending = Object.keys(index).find((defId) => {
      if (index[defId]?.kind !== "pokemon") return false;
      active.stack = [{ ...lent, defId }];
      return attacksFor(match, player)?.some((attack) => !attack.own) === true;
    });
    if (lending === undefined) throw new Error("ベンチのワザを使えるポケモンが見つからない");

    const attacks = attacksFor(match, player)!;
    const attackIndex = attacks.findIndex((attack) => !attack.own);
    const cards = index as unknown as CardTable;
    const label = describeMove(
      { type: "Attack", player, attackIndex },
      { view: viewFor(match, player), cards, attacks },
    );
    const name = index[lent.defId]!.name;
    expect(label).toBe(
      `ワザ「${index[lent.defId]!.attacks![0]}」を使う（自分のベンチの${name}のワザ）`,
    );
  });
});

describe("済んだ対戦を読み返す盤面", () => {
  it("相手が手札から出したカードも、名前で出す", () => {
    ensureCards();
    const match = newMatch("describe-move-reader");
    const views = [viewFor(match, 0), viewFor(match, 1)] as const;
    const [played] = views[1].self.hand;
    if (played === undefined) throw new Error("座席 1 の手札が空");
    const move: Move = {
      type: "PlayBasic",
      player: 1,
      cardInstanceId: played.instanceId,
      to: { kind: "bench", player: 1, index: 0 },
    };
    const cards = { [played.defId]: { name: "読み返すカード" } } as unknown as CardTable;

    expect(describeMove(move, { view: readerView(views, 0), cards })).toBe(
      "読み返すカード をベンチに出す",
    );
    // 座席の射影では、相手の手札の中身は見えない。
    expect(describeMove(move, { view: views[0], cards })).not.toContain("読み返すカード");
  });

  it("相手の選択の中身は、相手の射影から取る", () => {
    ensureCards();
    const match = newMatch("describe-move-reader");
    const views = [viewFor(match, 0), viewFor(match, 1)] as const;
    const owner = views[0].choices[0]?.owner;
    if (owner === undefined) throw new Error("選択が積まれていない");
    const reader = owner === 0 ? 1 : 0;
    expect(views[reader].choices[0]?.context).toBeNull();
    expect(readerView(views, reader).choices[0]?.context).not.toBeNull();
  });

  it("リプレイの見出しに、何手目か、直前の手、辿れない地点を出す", () => {
    ensureCards();
    const match = newMatch("describe-move-reader");
    const views: [PlayerView, PlayerView] = [viewFor(match, 0), viewFor(match, 1)];
    const text = replayStatusText(
      {
        matchId: match.matchId,
        ply: 0,
        moveCount: 4,
        views,
        playedMove: null,
        beforeViews: null,
        events: [[], []],
        engineCommitDiffers: true,
        divergedAt: null,
      },
      0,
      {},
      4,
    );
    expect(text).toContain("0 / 4 手　直前の手: 対戦の開始時");
    expect(text).toContain("エンジンの版が違います");
    expect(text).toContain("5 手目から先は、いまのエンジンでは再現できません");
  });
});

describe("choicePrompt", () => {
  const promptFor = (prompt: object, context: object | null, cards: CardTable = {}): string => {
    ensureCards();
    const view = viewFor(newMatch("describe-move-prompt"), 0);
    const choice = {
      choiceId: "c1",
      owner: 0,
      kind: "card-effect",
      optional: false,
      prompt,
      context,
    };
    return choicePrompt({ view: { ...view, choices: [choice] } as PlayerView, cards });
  };
  const shape = {
    source: { defId: "haipaboru", label: "効果の元", instanceId: null },
    sourceRole: "trainer",
    step: null,
    min: 2,
    max: 2,
    remaining: 1,
    picked: ["選んだ"],
    destination: "discard",
    revealsResult: true,
    window: null,
  };

  it("効果の元、候補のゾーン、行き先、残りの枚数、選んだカードを書く", () => {
    const hand = viewFor(newMatch("describe-move-prompt"), 0).self.hand.map(
      (card) => card.instanceId,
    );
    const cards = { 選んだ: { name: "選んだカード" } } as unknown as CardTable;
    expect(promptFor({ kind: "selectCard", candidates: hand }, shape, cards)).toBe(
      "効果の元：手札からトラッシュするカードを選んでください（あと 1 枚）。選んだカード: 選んだカード",
    );
  });

  it("相手の山札から選ぶときは、誰の山札かを書き、書かれていない枚数は出さない", () => {
    const loose = {
      ...shape,
      min: null,
      max: null,
      remaining: null,
      picked: null,
      destination: null,
    };
    const zone = { kind: "deck", player: 1 };
    expect(promptFor({ kind: "selectFromHiddenZone", zone, candidates: [] }, loose)).toBe(
      "効果の元：相手の山札からカードを選んでください。",
    );
  });

  it("ポケモンを選ぶときは、残りを匹で数える", () => {
    const one = { ...shape, min: 1, max: 1, remaining: 1, picked: null };
    expect(promptFor({ kind: "selectInPlay", candidates: [] }, one)).toBe(
      "効果の元：ポケモンを選んでください（あと 1 匹）。",
    );
  });

  it("カードやポケモンを選ぶのでなければ、枚数を書かない", () => {
    const confirm = { ...shape, picked: null };
    expect(promptFor({ kind: "confirm", count: 1 }, confirm)).toBe("効果の元：選んでください。");
  });

  it("選ぶのをやめる答えは、先に選んだカードがあれば「選び終える」、無ければ「選ばない」", () => {
    ensureCards();
    const view = viewFor(newMatch("describe-move-prompt"), 0);
    const decline = (picked: string[] | null) => {
      const choice = {
        choiceId: "c1",
        owner: 0,
        kind: "card-effect",
        optional: true,
        prompt: { kind: "selectFromHiddenZone", zone: { kind: "deck", player: 0 }, candidates: [] },
        context: { ...shape, picked },
      };
      return describeMove(
        { type: "AnswerChoice", player: 0, choiceId: "c1", answer: { kind: "decline" } },
        { view: { ...view, choices: [choice] } as PlayerView, cards: {} },
      );
    };
    expect(decline(["選んだ"])).toBe("選び終える");
    expect(decline([])).toBe("選ばない");
    expect(decline(null)).toBe("選ばない");
  });

  it("効果の元が分からない選択には書かない", () => {
    expect(promptFor({ kind: "selectInPlay", candidates: [] }, null)).toBe("");
  });
});

describe("エンジン自身が積む選択", () => {
  const withChoice = (
    kind: string,
    prompt: object,
    context: object | null = null,
    cards: CardTable = {},
  ) => {
    ensureCards();
    const view = viewFor(newMatch("describe-move-rule"), 0);
    const choice = { choiceId: "c1", owner: 0, kind, optional: true, prompt, context };
    return { view: { ...view, choices: [choice] } as PlayerView, cards };
  };
  const answer = (context: ReturnType<typeof withChoice>, picked: ChoiceAnswer) =>
    describeMove({ type: "AnswerChoice", player: 0, choiceId: "c1", answer: picked }, context);

  it("効果の元が無くても、何を選ぶのかを書く", () => {
    const source = { defId: "x", label: "効果の元", instanceId: null };
    const prompts = [
      withChoice("use-second-attack", { kind: "confirm", count: 1 }),
      withChoice("select-attack", { kind: "selectAttack", candidates: [] }),
      withChoice("order-effects", { kind: "selectEffect", candidates: [], context: "trigger" }),
      withChoice("place-check-effect", { kind: "selectPlacement", effect: source }),
      withChoice("take-prize", {
        kind: "selectPrize",
        zone: { kind: "prizes", player: 0 },
        positions: [],
        remaining: [2, 0],
        total: [2, 0],
        checkOutcome: true,
      }),
    ].map(choicePrompt);
    expect(prompts.filter((prompt) => prompt === "")).toEqual([]);
  });

  it("2 回目のワザを使うかの答えは、使うか番を終えるかで出す", () => {
    const context = withChoice("use-second-attack", { kind: "confirm", count: 1 });
    expect(answer(context, { kind: "accept" })).toBe("もう一度ワザを使う");
    expect(answer(context, { kind: "decline" })).toBe("使わずに番を終える");
  });

  it("取るサイドはオモテなら名前、ウラならウラのサイドで出す", () => {
    const prize = {
      kind: "selectPrize",
      zone: { kind: "prizes", player: 0 },
      positions: [
        { index: 0, defId: null },
        { index: 3, defId: "オモテ" },
      ],
      remaining: [2, 0],
      total: [2, 0],
      checkOutcome: true,
    };
    const cards = { オモテ: { name: "オモテのカード" } } as unknown as CardTable;
    const context = withChoice("take-prize", prize, null, cards);
    expect(answer(context, { kind: "position", index: 0 })).toBe("ウラのサイドを取る");
    expect(answer(context, { kind: "position", index: 3 })).toBe("オモテの オモテのカード を取る");
  });

  it("効果の順番の答えは効果の名前で出し、同じ名前が並ぶときは何番目かを足す", () => {
    const twin = { defId: "y", label: "同じ効果", instanceId: null };
    const candidates = [{ defId: "x", label: "先の効果", instanceId: null }, twin, twin];
    const context = withChoice("order-effects", {
      kind: "selectEffect",
      candidates,
      context: "trigger",
    });
    expect(answer(context, { kind: "effectIndex", index: 0 })).toBe("先の効果");
    expect(answer(context, { kind: "effectIndex", index: 2 })).toBe("同じ効果（3 番目）");
  });
});
