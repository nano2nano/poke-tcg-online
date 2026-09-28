/**
 * 盤面とイベントを、人に見せる文へ直す。
 *
 * 値はプロトコルが運んだものだけを使い、射影に無い値（残りの HP など）は計算しない。
 * どうぐや効果で最大 HP が変わると、画面だけが嘘をつく。
 */

import type {
  GameOutcome,
  Player,
  PlayerEvent,
  PlayerView,
  SpectatorView,
} from "../../src/engine.js";
import type { ClockView, EndedMessage, RejectReason, SpectatorSeat } from "../../src/protocol.js";
import type { CardBrief, CardTable } from "./cards.js";

/** 1 人ぶんの場。手札の中身が見えるのは自分の座席だけで、ほかは枚数だけが届く。 */
export type Side = SpectatorView["players"][number] | PlayerView["self"];
export type SpecialCondition = Extract<
  NonNullable<Side["active"]>,
  { conditions: unknown }
>["conditions"][number];

const STAGES: Record<string, string> = { basic: "たね", stage1: "1 進化", stage2: "2 進化" };
const KINDS: Record<string, string> = {
  pokemon: "ポケモン",
  trainer: "トレーナーズ",
  energy: "エネルギー",
};
const KIND_ORDER = Object.keys(KINDS);
const TYPES: Record<string, string> = {
  grass: "草",
  fire: "炎",
  water: "水",
  lightning: "雷",
  psychic: "超",
  fighting: "闘",
  darkness: "悪",
  metal: "鋼",
  dragon: "竜",
  colorless: "無色",
};
const TRAINER_KINDS: Record<string, string> = {
  item: "グッズ",
  supporter: "サポート",
  tool: "ポケモンのどうぐ",
  stadium: "スタジアム",
};
const HALVES: Record<string, string> = { left: "左", right: "右" };
const CONDITIONS: Record<string, string> = {
  poisoned: "どく",
  burned: "やけど",
  asleep: "ねむり",
  paralyzed: "マヒ",
  confused: "こんらん",
};

/** 山札を種類で並べるときの順。 */
export function kindRank(card: CardBrief | undefined): number {
  const index = card === undefined ? -1 : KIND_ORDER.indexOf(card.kind);
  return index === -1 ? KIND_ORDER.length : index;
}

export function nameOf(cards: CardTable, defId: string): string {
  return cards[defId]?.name ?? defId;
}

/** カードの面の下の段。ポケモンは HP、ほかは種類。 */
export function cardSubtitle(card: CardBrief | undefined): string {
  if (card === undefined) return "";
  if (card.hp !== undefined) return `HP ${card.hp}`;
  return (
    (card.trainerKind === undefined ? undefined : TRAINER_KINDS[card.trainerKind]) ??
    KINDS[card.kind] ??
    ""
  );
}

/** 同じ名前の別のカードを見分けるための 1 行。 */
export function describeCard(card: CardBrief | undefined): string {
  if (card === undefined) return "";
  const parts: string[] = [];
  if (card.kind === "pokemon") {
    parts.push(
      [
        card.stage === undefined ? "" : (STAGES[card.stage] ?? card.stage),
        card.type === undefined ? "" : (TYPES[card.type] ?? card.type),
        card.hp === undefined ? "" : `HP ${card.hp}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (card.abilities !== undefined && card.abilities.length > 0) {
      parts.push(`特性 ${card.abilities.join("・")}`);
    }
    if (card.attacks !== undefined && card.attacks.length > 0) {
      parts.push(`ワザ ${card.attacks.join("・")}`);
    }
  } else if (card.kind === "trainer") {
    parts.push(
      (card.trainerKind === undefined ? undefined : TRAINER_KINDS[card.trainerKind]) ??
        KINDS.trainer!,
    );
    if (card.stadiumHalf !== undefined) parts.push(`${HALVES[card.stadiumHalf]}半分`);
  } else {
    parts.push(card.basicEnergy ? "基本エネルギー" : (KINDS[card.kind] ?? card.kind));
  }
  if (card.aceSpec) parts.push("ACE SPEC");
  parts.push([card.set, card.number].filter(Boolean).join(" "));
  return parts.filter(Boolean).join(" / ");
}

export function conditionName(condition: Pick<SpecialCondition, "kind">): string {
  return CONDITIONS[condition.kind] ?? condition.kind;
}

/** 座席の名前。観戦の画面は、座席の番号の代わりにこれで呼ぶ。 */
export function seatDisplayName(seats: readonly SpectatorSeat[] | null, player: Player): string {
  return seats?.[player]?.displayName ?? `座席 ${player}`;
}

function moveRemainingText(clock: ClockView): string {
  return clock.moveRemainingMs === null
    ? ""
    : `（この手の残り ${Math.round(clock.moveRemainingMs / 1000)} 秒）`;
}

export function seatClockText(clock: ClockView, seat: Player): string {
  const mine = Math.round(clock.bankMs[seat] / 1000);
  const theirs = Math.round(clock.bankMs[seat === 0 ? 1 : 0] / 1000);
  // 決着した局面では、どちらの番でもない。
  const turn =
    clock.toMove === null ? "" : clock.toMove === seat ? "あなたの番です" : "相手が考えています";
  return `${turn}${moveRemainingText(clock)} ／ 持ち時間 自分 ${mine} 秒・相手 ${theirs} 秒`;
}

export function watchClockText(clock: ClockView, who: (player: Player) => string): string {
  const turn = clock.toMove === null ? "" : `${who(clock.toMove)} が考えています`;
  const banks = ([0, 1] as const)
    .map((player) => `${who(player)} ${Math.round(clock.bankMs[player] / 1000)} 秒`)
    .join("・");
  return `${turn}${moveRemainingText(clock)} ／ 持ち時間 ${banks}`;
}

export function watchEndText(
  result: { winner: Player | null; kind: string },
  who: (player: Player) => string,
): string {
  if (result.winner === null) return "引き分けで終わりました";
  const how: Record<string, string> = { concede: "（投了）", timeout: "（時間切れ）" };
  return `${who(result.winner)} の勝ちで終わりました${how[result.kind] ?? ""}`;
}

const WIN_REASONS: Record<GameOutcome["reason"], string> = {
  "prizes-taken": "サイドを取りきった",
  "no-pokemon": "場のポケモンがいなくなった",
  "deck-out": "山札を引けなかった",
  "effect-declared": "カードの効果",
  "turn-limit": "手数の上限",
};

export function seatEndText(
  ended: Pick<EndedMessage, "matchResult" | "outcome">,
  seat: Player,
): string {
  const result = ended.matchResult;
  const mine = result.winner === seat ? "勝ち" : "負け";
  if (result.kind === "concede") return `投了により ${mine}`;
  if (result.kind === "timeout") return `時間切れにより ${mine}`;
  if (result.winner === null) return "引き分け";
  const reason = ended.outcome?.reason;
  return reason === undefined ? mine : `${mine}（${WIN_REASONS[reason]}）`;
}

export function seatEndTone(winner: Player | null, seat: Player): Tone {
  if (winner === null) return "neutral";
  return winner === seat ? "positive" : "negative";
}

/** 手を断った理由（仕様 2.2 節）。 */
const REJECT_REASONS: Record<RejectReason, string> = {
  "not-your-turn": "あなたの番ではありません",
  "stale-version": "盤面が先に進んでいました",
  "illegal-move": "いまは指せない手です",
  "match-over": "対戦は終わっています",
};

export function rejectText(reason: RejectReason): string {
  return `手が通りませんでした（${REJECT_REASONS[reason]}）`;
}

export type Tone = "neutral" | "turn" | "attention" | "positive" | "negative";

export interface CoinToss {
  results: boolean[];
  faces: [string, string];
}

/** ダメージや回復の数字を、そのポケモンの上に浮かべる。 */
export interface Hit {
  target: string;
  text: string;
  tone: "negative" | "positive";
}

export interface Notice {
  text: string;
  tone?: Tone;
  coins?: CoinToss;
  hit?: Hit;
  /** 同じ `key` が続いたら 1 つに畳む。 */
  key?: string;
  repeated?: boolean;
}

export type View = PlayerView | SpectatorView;

/**
 * 届いたイベントを、人に見せる結果へ直す。見せないイベントの位置は null にする。
 * 名前は適用後と適用前の盤面から引く。きぜつしたポケモンは適用後の盤面にもういない。
 */
export function describeEvents(
  events: readonly PlayerEvent[],
  views: readonly (View | null)[],
  who: (player: Player) => string,
  cards: CardTable,
): (Notice | null)[] {
  let previous: Notice | null = null;
  return events.map((event) => {
    const notice = describeEvent(event, views, who, cards);
    const repeated = notice?.key !== undefined && notice.key === previous?.key;
    previous = notice;
    return repeated ? { ...notice, repeated: true } : notice;
  });
}

function describeEvent(
  event: PlayerEvent,
  views: readonly (View | null)[],
  who: (player: Player) => string,
  cards: CardTable,
): Notice | null {
  const pokemon = (inPlayId: string) => pokemonName(inPlayId, views, who, cards) ?? "ポケモン";
  switch (event.kind) {
    case "coin-flipped": {
      const heads = event.results.filter(Boolean).length;
      const tails = event.results.length - heads;
      const summary =
        event.results.length === 1
          ? event.results[0]
            ? "オモテ"
            : "ウラ"
          : `オモテ ${heads} 回・ウラ ${tails} 回`;
      const cause =
        event.source !== null
          ? `（${nameOf(cards, event.source.defId)}）`
          : event.window.kind === "pokemon-check"
            ? "（ポケモンチェック）"
            : "";
      return {
        text: `${who(event.player)}のコイン${cause}: ${summary}`,
        coins: { results: event.results, faces: ["オモテ", "ウラ"] },
      };
    }
    case "damage-dealt":
      return {
        text: `${pokemon(event.target)}に ${event.amount} ダメージ`,
        hit: { target: event.target, text: `-${event.amount}`, tone: "negative" },
      };
    case "damage-counters-placed": {
      // 載せた数は HP で頭打ちになる。浮かべるのは実際に増えたダメージのほうにする。
      const amount = event.afterDamage - event.beforeDamage;
      return {
        text: `${pokemon(event.target)}にダメカンを ${event.count} 個`,
        ...(amount > 0
          ? { hit: { target: event.target, text: `-${amount}`, tone: "negative" } }
          : {}),
      };
    }
    case "damage-healed":
      return {
        text: `${pokemon(event.target)}の HP を ${event.amount} 回復`,
        tone: "positive",
        hit: { target: event.target, text: `+${event.amount}`, tone: "positive" },
      };
    case "condition-applied":
      return { text: `${pokemon(event.target)}が${conditionName(event.condition)}になった` };
    case "condition-removed":
      return { text: `${pokemon(event.target)}の${conditionName(event.condition)}が治った` };
    case "pokemon-knocked-out":
      return { text: `${pokemon(event.target)}がきぜつした`, tone: "attention" };
    // まとめて取ると 1 枚ごとのイベントが続けて並ぶ。選んで取るときは 1 枚ずつ別の局面で届くので、
    // 枚数は `count`（今回取る総数）ではなく残りで伝え、続いたものは 1 つに畳む。
    case "prize-taken":
    case "prize-taken-hidden": {
      const side = sidesOf(views[0] ?? null).find(([player]) => player === event.player)?.[1];
      const left = side === undefined ? "" : `（残り ${side.prizeCount} 枚）`;
      return { text: `${who(event.player)}がサイドを取った${left}`, key: `prize-${event.player}` };
    }
    case "mulligan-taken":
      return { text: `${who(event.player)}の手札にたねポケモンが無く、引き直した` };
    case "turn-started":
      return { text: `${who(event.player)}の番`, tone: "turn" };
    default:
      return null;
  }
}

/**
 * できごとの記録に足す行。人に見せる文が無いイベントは、不具合を調べるときのために名前で残す。
 * 畳んだ結果は足さない。
 */
export function eventLines(
  events: readonly PlayerEvent[],
  notices: readonly (Notice | null)[],
): string[] {
  return events.flatMap((event, index) => {
    const notice = notices[index];
    return notice?.repeated ? [] : [notice?.text ?? event.kind];
  });
}

/** 場のポケモンを「持ち主の名前」で呼ぶ。見つからなければ null。 */
function pokemonName(
  inPlayId: string,
  views: readonly (View | null)[],
  who: (player: Player) => string,
  cards: CardTable,
): string | null {
  for (const view of views) {
    for (const [player, side] of sidesOf(view)) {
      for (const pokemon of [side.active, ...side.bench]) {
        if (pokemon == null || "concealed" in pokemon || pokemon.inPlayId !== inPlayId) continue;
        return `${who(player)}の${nameOf(cards, pokemon.stack[pokemon.stack.length - 1]!.defId)}`;
      }
    }
  }
  return null;
}

/** 座席の番号と、その座席の場の組。座席と観戦で盤面の形が違う。 */
export function sidesOf(view: View | null): [Player, Side][] {
  if (view === null) return [];
  if (view.viewer === "spectator")
    return [
      [0, view.players[0]],
      [1, view.players[1]],
    ];
  return [
    [view.viewer, view.self],
    [view.viewer === 0 ? 1 : 0, view.opponent],
  ];
}
