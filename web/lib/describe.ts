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
  Zone,
} from "../../src/engine.js";
import type { MatchSummary } from "../../src/archive.js";
import type { ClockView, EndedMessage, RejectReason, SpectatorSeat } from "../../src/protocol.js";
import type { CardBrief, CardTable } from "./cards.js";

/** 1 人ぶんの場。手札の中身が見えるのは自分の座席だけで、ほかは枚数だけが届く。 */
export type Side = SpectatorView["players"][number] | PlayerView["self"];
export type SpecialCondition = Extract<
  NonNullable<Side["active"]>,
  { conditions: unknown }
>["conditions"][number];

const STAGES: Record<string, string> = { basic: "たね", stage1: "1 進化", stage2: "2 進化" };
export const KINDS: Record<string, string> = {
  pokemon: "ポケモン",
  trainer: "トレーナーズ",
  energy: "エネルギー",
};
export const KIND_ORDER = Object.keys(KINDS);
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

/** カードの面の下の段。ポケモンは HP、ほかは種類。2 枚 1 組のスタジアムは左右も添える。 */
export function cardSubtitle(card: CardBrief | undefined): string {
  if (card === undefined) return "";
  if (card.hp !== undefined) return `HP ${card.hp}`;
  const kind =
    (card.trainerKind === undefined ? undefined : TRAINER_KINDS[card.trainerKind]) ??
    KINDS[card.kind] ??
    "";
  return card.stadiumHalf === undefined ? kind : `${kind} ${HALVES[card.stadiumHalf]}半分`;
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
  /** 大きく見せるカードの defId。出たカードを、文を読む前に絵で分かるようにする。 */
  card?: string;
  /** 誰がしたことか。座席の画面は、自分でしたことを結果に出さない。 */
  by?: Player;
  /** 記録にだけ残し、結果には出さない。 */
  quiet?: boolean;
}

export type View = PlayerView | SpectatorView;

/**
 * 済んだ対戦を読み返す盤面。相手の側も相手自身の射影から取るので、相手の手札まで見える（仕様 6.6 節）。
 * 座席の射影より見えるものが多いだけなので、座席の射影もこの形として読める。
 */
export type ReaderView = Omit<PlayerView, "opponent"> & { opponent: Side };

/**
 * 座席ごとの射影 2 つを、`seat` に座っていた人から見た 1 枚の盤面にする。
 * 選択の中身は持ち主の射影にしか載らないので、相手の選択は相手の射影から取る。
 */
export function readerView(views: readonly [PlayerView, PlayerView], seat: Player): ReaderView {
  const other = views[seat === 0 ? 1 : 0];
  return {
    ...views[seat],
    opponent: other.self,
    choices: views[seat].choices.map((choice) =>
      choice.owner === seat
        ? choice
        : (other.choices.find(({ choiceId }) => choiceId === choice.choiceId) ?? choice),
    ),
  };
}

/** 指した対戦の一覧の 1 行。 */
export function describeSummary(summary: MatchSummary): string {
  const outcome = { win: "勝ち", loss: "負け", draw: "引き分け" }[summary.outcome];
  const how = { normal: "", concede: "（投了）", timeout: "（時間切れ）" }[
    summary.matchResult.kind
  ];
  const when = new Date(summary.endedAt).toLocaleString("ja-JP");
  return `${when} ${summary.opponentName} と ${outcome}${how} ${summary.moveCount} 手`;
}

/**
 * 届いたイベントを、人に見せる結果へ直す。人に見せる文の無いイベントは落とす。
 * 名前は適用後と適用前の盤面から引く。きぜつしたポケモンは適用後の盤面にもういない。
 * 1 枚ずつ届くイベント（引く、トラッシュする、移す、サイドを取る）が続いたら、1 つにまとめる。
 */
export function describeEvents(
  events: readonly PlayerEvent[],
  views: readonly (View | null)[],
  who: (player: Player) => string,
  cards: CardTable,
): Notice[] {
  // トレーナーズを使うと、使ったカードをトラッシュするイベントが続く。使ったことは 1 つの文で言う。
  const played = new Set(
    events.flatMap((event) => (event.kind === "trainer-played" ? [event.card.instanceId] : [])),
  );
  const told = events.filter(
    (event) => event.kind !== "card-discarded" || !played.has(event.card.instanceId),
  );
  const notices: Notice[] = [];
  let start = 0;
  while (start < told.length) {
    const key = foldKey(told[start]!);
    const folds = (event: PlayerEvent) => key !== undefined && foldKey(event) === key;
    let end = start + 1;
    while (end < told.length && folds(told[end]!)) end += 1;
    const notice = describeRun(told.slice(start, end), views, who, cards);
    if (notice !== null) notices.push(notice);
    start = end;
  }
  return notices;
}

/** 結果として画面に出すもの。`self` を渡すと、その座席が自分でしたことは出さない。 */
export function noticesToShow(notices: readonly Notice[], self?: Player): Notice[] {
  return notices.filter((notice) => !notice.quiet && (self === undefined || notice.by !== self));
}

export const ZONES: Record<Zone["kind"], string> = {
  deck: "山札",
  hand: "手札",
  discard: "トラッシュ",
  prizes: "サイド",
  lostZone: "ロストゾーン",
  active: "バトル場",
  bench: "ベンチ",
  stadium: "スタジアム",
};

/** 畳んだ文は先頭のイベントの `actor` と `source` で書くので、それが違うイベントは畳まない。 */
function foldKey(event: PlayerEvent): string | undefined {
  const zone = (at: Zone) => (at.kind === "stadium" ? at.kind : `${at.kind} ${at.player}`);
  const cause = `${event.actor} ${event.source?.instanceId}`;
  switch (event.kind) {
    case "card-drawn":
    case "card-drawn-hidden":
      return `draw ${event.player} ${cause}`;
    case "card-discarded":
      return `discard ${event.player} ${cause}`;
    case "card-moved":
    case "card-moved-hidden":
      return `${event.kind} ${zone(event.from)} ${zone(event.to)} ${cause}`;
    case "prize-taken":
    case "prize-taken-hidden":
      return `prize ${event.player} ${cause}`;
    default:
      return undefined;
  }
}

function describeRun(
  run: readonly PlayerEvent[],
  views: readonly (View | null)[],
  who: (player: Player) => string,
  cards: CardTable,
): Notice | null {
  const event = run[0]!;
  const name = (defId: string) => nameOf(cards, defId);
  const names = () => {
    const counts = new Map<string, number>();
    for (const each of run) {
      for (const card of "card" in each ? [each.card] : "cards" in each ? each.cards : []) {
        const named = name(card.defId);
        counts.set(named, (counts.get(named) ?? 0) + 1);
      }
    }
    return [...counts]
      .map(([named, count]) => (count === 1 ? named : `${named} ${count} 枚`))
      .join("・");
  };
  /** 場のポケモンの名前。`subject` と持ち主が違うときだけ、持ち主の名前を前に付ける。 */
  const pokemon = (inPlayId: string, subject: Player | null = null, from = views) => {
    const found = findPokemon(inPlayId, from);
    if (found === null) return "ポケモン";
    return found.player === subject
      ? name(found.defId)
      : `${who(found.player)}の${name(found.defId)}`;
  };
  const place = (zone: Zone, subject: Player | null) =>
    zone.kind === "stadium" || zone.player === subject
      ? ZONES[zone.kind]
      : `${who(zone.player)}の${ZONES[zone.kind]}`;
  // どうぐは、つけたカード自身を `source` に持つ。
  const cause =
    event.source === null || ("card" in event && event.card.instanceId === event.source.instanceId)
      ? ""
      : `（${name(event.source.defId)}）`;
  // 自分でしたことかは、誰の番に起きたかで決める。`actor` は効果を受けた側を指すことがある（入れ替えなど）。
  const byTurn = (player: Player) => (event.window.kind === "turn" ? event.window.player : player);
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
      const why =
        event.source !== null
          ? cause
          : event.window.kind === "pokemon-check"
            ? "（ポケモンチェック）"
            : "";
      return {
        text: `${who(event.player)}のコイン${why}: ${summary}`,
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
    // 枚数は `count`（今回取る総数）ではなく残りで伝える。
    case "prize-taken":
    case "prize-taken-hidden": {
      const side = sidesOf(views[0] ?? null).find(([player]) => player === event.player)?.[1];
      const left = side === undefined ? "" : `（残り ${side.prizeCount} 枚）`;
      return { text: `${who(event.player)}がサイドを取った${left}` };
    }
    case "mulligan-taken":
      return { text: `${who(event.player)}の手札にたねポケモンが無く、引き直した` };
    case "turn-started":
      return { text: `${who(event.player)}の番`, tone: "turn" };
    case "card-drawn":
    case "card-drawn-hidden":
      return {
        text: `${who(event.player)}がカードを ${run.length} 枚引いた`,
        by: byTurn(event.player),
      };
    case "card-discarded": {
      // きぜつしたポケモンをトラッシュするときなど、ルールが動かしたものは記録にだけ残す。
      if (event.actor === null) {
        return { text: `${who(event.player)}の${names()}をトラッシュした`, quiet: true };
      }
      const whose = event.actor === event.player ? "" : `${who(event.player)}の`;
      return {
        text: `${who(event.actor)}が${whose}${names()}をトラッシュした${cause}`,
        by: byTurn(event.actor),
      };
    }
    case "card-moved":
    case "card-moved-hidden": {
      const subject = event.actor ?? (event.from.kind === "stadium" ? null : event.from.player);
      const what = event.kind === "card-moved" ? names() : ` ${run.length} 枚`;
      const text = `${what}を${place(event.from, subject)}から${place(event.to, subject)}へ移した${cause}`;
      return subject === null
        ? { text: text.trimStart() }
        : { text: `${who(subject)}が${text}`, by: byTurn(subject) };
    }
    case "cards-revealed":
      if (event.reshow === true) return null;
      return {
        text: `${who(event.player)}が${place(event.zone, event.player)}の${names()}を${event.audience === "public" ? "見せた" : "見た"}${cause}`,
        by: byTurn(event.player),
        quiet: true,
      };
    case "cards-revealed-hidden":
      return {
        text: `${who(event.player)}が${place(event.zone, event.player)}の ${event.count} 枚を見た${cause}`,
        by: byTurn(event.player),
        quiet: true,
      };
    case "deck-shuffled":
      return { text: `${who(event.player)}が山札を切った`, by: byTurn(event.player), quiet: true };
    case "card-name-declared":
      return {
        text: `${who(event.player)}が${name(event.defId)}を宣言した`,
        by: byTurn(event.player),
      };
    case "pokemon-played":
      return {
        text: `${who(event.player)}が${name(event.card.defId)}を${ZONES[event.to.kind]}に出した`,
        card: event.card.defId,
        by: byTurn(event.player),
      };
    case "pokemon-played-hidden":
      return {
        text: `${who(event.player)}が${ZONES[event.to.kind]}にポケモンを裏向きで出した`,
        by: byTurn(event.player),
      };
    case "pokemon-evolved": {
      // 適用後の盤面では、もう進化したあとの名前になっている。
      const before = pokemon(event.target, event.player, [...views].reverse());
      return {
        text: `${who(event.player)}の${before}が${name(event.card.defId)}に進化した`,
        card: event.card.defId,
        by: byTurn(event.player),
      };
    }
    case "pokemon-devolved":
      return {
        // 適用後の盤面では、もう退化したあとの名前になっている。
        text: `${pokemon(event.target, null, [...views].reverse())}が退化した${cause}`,
        by: byTurn(event.player),
      };
    case "pokemon-replaced":
    case "pokemon-top-card-replaced": {
      const old = event.kind === "pokemon-replaced" ? event.oldCards.at(-1) : event.oldCard;
      const from = old === undefined ? "ポケモン" : name(old.defId);
      return {
        text: `${who(event.player)}の${from}が${name(event.newCard.defId)}になった${cause}`,
        card: event.newCard.defId,
        by: byTurn(event.player),
      };
    }
    case "trainer-played":
    case "stadium-played":
      return {
        text: `${who(event.player)}が${name(event.card.defId)}を${event.kind === "trainer-played" ? "使った" : "出した"}`,
        card: event.card.defId,
        by: byTurn(event.player),
      };
    case "stadium-effect-used":
      return {
        text: `${who(event.player)}が${name(event.card.defId)}の効果を使った`,
        card: event.card.defId,
        by: byTurn(event.player),
      };
    case "energy-attached":
    case "tool-attached":
      return {
        text: `${who(event.player)}が${pokemon(event.target, event.player)}に${name(event.card.defId)}をつけた${cause}`,
        card: event.card.defId,
        by: byTurn(event.player),
      };
    case "ability-used":
    case "attack-declared": {
      const found = findPokemon(event.sourceInPlay, views);
      const attack =
        event.kind === "attack-declared"
          ? printedAttack(cards, found?.defId, event.attackIndex)
          : undefined;
      const what =
        event.kind === "ability-used"
          ? abilityName(cards, found?.defId, event.abilityIndex)
          : attack === undefined
            ? "ワザ"
            : `ワザ「${attack}」`;
      return {
        text: `${who(event.player)}の${pokemon(event.sourceInPlay, event.player)}が${what}を使った`,
        ...(found === null ? {} : { card: found.defId }),
        by: byTurn(event.player),
      };
    }
    case "hand-ability-used":
      return { text: `${who(event.player)}が手札のカードの特性を使った`, by: byTurn(event.player) };
    case "pokemon-retreated":
      return {
        text: `${who(event.player)}が${pokemon(event.from, event.player)}をにがし、${pokemon(event.to, event.player)}をバトル場に出した`,
        by: byTurn(event.player),
      };
    case "pokemon-switched":
      return {
        text: `${who(event.player)}の${pokemon(event.from, event.player)}と${pokemon(event.to, event.player)}が入れ替わった${cause}`,
        by: byTurn(event.player),
      };
    case "pokemon-promoted":
      return {
        text: `${who(event.player)}が${pokemon(event.target, event.player)}をバトル場に出した`,
        // きぜつのあとは、相手の番でもポケモンの持ち主が選ぶ。
        by: event.player,
      };
    // 手順の区切りと、ほかのイベントが言っていることの言い直し。先攻と決着は、別の知らせで出す。
    case "game-started":
    case "game-ended":
    case "no-basic-declared":
    case "attack-resolved":
    case "attack-damage-stage4":
    case "knockout-batch-started":
    case "knockout-batch-trashed":
    case "knockout-batch-completed":
    case "turn-ended":
    case "phase-changed":
    case "pokemon-check-started":
    case "pokemon-check-completed":
    case "choice-requested":
    case "choice-answered":
      return null;
    default:
      // エンジンにイベントが増えたら、ここで型が合わなくなる。文を書き足すまで、記録にも出さない。
      event satisfies never;
      return null;
  }
}

export function abilityName(cards: CardTable, defId: string | undefined, index: number): string {
  const name = defId === undefined ? undefined : cards[defId]?.abilities?.[index];
  return name === undefined ? "特性" : `特性「${name}」`;
}

/**
 * `attackIndex` は印刷されたワザの番号ではなく、どうぐなどで使えるようになったワザを
 * 後ろに足した表の番号である（`engine/docs/spec/engine-core.md` 3.3 節）。印刷されたワザが前に並ぶので、
 * その数より小さければ名前が引ける。
 */
export function printedAttack(
  cards: CardTable,
  defId: string | undefined,
  index: number,
): string | undefined {
  return defId === undefined ? undefined : cards[defId]?.attacks?.[index];
}

/** 場のポケモンの持ち主と、いちばん上のカード。見つからなければ null。 */
function findPokemon(
  inPlayId: string,
  views: readonly (View | null)[],
): { player: Player; defId: string } | null {
  for (const view of views) {
    for (const [player, side] of sidesOf(view)) {
      for (const pokemon of [side.active, ...side.bench]) {
        if (pokemon == null || "concealed" in pokemon || pokemon.inPlayId !== inPlayId) continue;
        return { player, defId: pokemon.stack[pokemon.stack.length - 1]!.defId };
      }
    }
  }
  return null;
}

/** 座席の番号と、その座席の場の組。座席と観戦で盤面の形が違う。 */
export function sidesOf(view: View | ReaderView | null): [Player, Side][] {
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
