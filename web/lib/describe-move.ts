/**
 * 座席の画面で、指せる手と選択の答えを人に読める見出しにする。
 *
 * 名前を引くのは **その手を指す直前の盤面** からである。指したあとの盤面では、
 * 出したカードはもう手札に無い。指せる手を並べるときは、今の盤面がその直前にあたる。
 */

import type { ChoiceAnswer, Move, PlayerView } from "../../src/engine.js";
import type { AnswerDestination, DeckPlacementView, SetupView } from "../../src/match.js";
import type { CardTable } from "./cards.js";
import { nameOf, sidesOf, type Side } from "./describe.js";

type Pokemon = NonNullable<Side["active"]>;

/** 見出しを作るのに要るもの。盤面は座席から見たもの。 */
export interface MoveContext {
  view: PlayerView | null;
  cards: CardTable;
}

/**
 * 座席から見た両側と、それが自分の側か。
 * 対戦中は相手の手札が `hand` を持たないので、自分の手札しか当たらない。
 */
function seatSides(view: PlayerView | null): [boolean, Side][] {
  return sidesOf(view).map(([player, side]) => [player === view?.viewer, side]);
}

/** 描いている順のベンチ。空いた枠は描かないので、左からの番号もこれで数える。 */
function benched(side: Side): Pokemon[] {
  const slots: readonly (Pokemon | null)[] = side.bench;
  return slots.filter((pokemon) => pokemon !== null);
}

function pokemonAt(inPlayId: string, view: PlayerView | null) {
  for (const [own, side] of seatSides(view)) {
    const active = side.active;
    if (active !== null && "inPlayId" in active && active.inPlayId === inPlayId) {
      return { own, side, pokemon: active, bench: -1 };
    }
    const bench = benched(side);
    const index = bench.findIndex(
      (pokemon) => "inPlayId" in pokemon && pokemon.inPlayId === inPlayId,
    );
    if (index >= 0) return { own, side, pokemon: bench[index]!, bench: index };
  }
  return null;
}

function topName(pokemon: Pokemon, cards: CardTable): string {
  return "concealed" in pokemon
    ? "ウラのポケモン"
    : nameOf(cards, pokemon.stack[pokemon.stack.length - 1]!.defId);
}

/**
 * 場のポケモンを、いる場所と合わせて書く。ベンチに同じ名前が並ぶときは左からの番号を足す。
 * `withSide` が偽なら、自分の側では「自分の」を省く。自分の番の手は自分の場にしか向かない。
 */
export function pokemonLabel(inPlayId: string, { view, cards }: MoveContext, withSide: boolean) {
  const found = pokemonAt(inPlayId, view);
  if (found === null) return inPlayId;
  const name = topName(found.pokemon, cards);
  const twins = benched(found.side).filter((pokemon) => topName(pokemon, cards) === name).length;
  const place =
    found.bench < 0 ? "バトル場" : twins > 1 ? `ベンチ左から ${found.bench + 1} 番目` : "ベンチ";
  const side = found.own ? (withSide ? "自分の" : "") : "相手の";
  return `${side}${place}の${name}`;
}

interface Located {
  defId: string;
  own: boolean;
  zone: "hand" | "discard" | "lost" | "stack" | "attached";
  place: string;
}

/**
 * インスタンス ID から、カードと、それがある場所を引く。盤面に無ければ null（山札の中など）。
 *
 * 同じ場所に同じカードが何枚かあるときは、盤面で見分けられる順番を `place` に足す。
 * ついているカードは左から描き、トラッシュとロストゾーンは大きく出すと上から並ぶ。
 */
export function locateCard(instanceId: string, context: MoveContext): Located | null {
  for (const [own, side] of seatSides(context.view)) {
    const who = own ? "自分の" : "相手の";
    const piles: [
      Located["zone"],
      () => string,
      { instanceId: string; defId: string }[],
      string,
    ][] = [
      ["hand", () => `${who}手札`, "hand" in side ? side.hand : [], "左から"],
      ["discard", () => `${who}トラッシュ`, [...side.discard].reverse(), "上から"],
      ["lost", () => `${who}ロストゾーン`, [...side.lostZone].reverse(), "上から"],
    ];
    for (const pokemon of [side.active, ...benched(side)]) {
      if (pokemon === null || "concealed" in pokemon) continue;
      const holder = () => pokemonLabel(pokemon.inPlayId, context, true);
      piles.push(
        ["stack", holder, [...pokemon.stack].reverse(), "上から"],
        ["attached", holder, pokemon.attached, "左から"],
      );
    }
    for (const [zone, where, pile, from] of piles) {
      const card = pile.find((each) => each.instanceId === instanceId);
      if (card === undefined) continue;
      const twins = pile.filter((each) => each.defId === card.defId);
      const place =
        twins.length > 1 ? `${where()}の${from} ${twins.indexOf(card) + 1} 枚目` : where();
      return { defId: card.defId, own, zone, place };
    }
  }
  return null;
}

/** 盤面に無ければ番号のまま出す。 */
function cardName(instanceId: string, context: MoveContext): string {
  const found = locateCard(instanceId, context);
  return found === null ? instanceId : nameOf(context.cards, found.defId);
}

/** 選択の候補のカード。手札から選ぶことが多いので、手札のときだけ場所を省く。 */
function cardWithPlace(instanceId: string, context: MoveContext): string {
  const found = locateCard(instanceId, context);
  if (found === null) return instanceId;
  const name = nameOf(context.cards, found.defId);
  return found.zone === "hand" && found.own ? name : `${name}（${found.place}）`;
}

/** 手札に無ければ番号のまま出す。 */
export function handCardName(instanceId: string, context: MoveContext): string {
  const found = locateCard(instanceId, context);
  return found?.zone === "hand" ? nameOf(context.cards, found.defId) : instanceId;
}

/** 手札か自分の場にある自分のカードの名前。出したあとのカードは手札から場へ移っている。 */
function ownCardName(instanceId: string, context: MoveContext): string {
  const found = locateCard(instanceId, context);
  const mine = found?.own === true && (found.zone === "hand" || found.zone === "stack");
  return mine ? nameOf(context.cards, found.defId) : instanceId;
}

/**
 * 手の見出し。`Move` は判別可能ユニオンなので、型ごとに 1 行で書ける。
 * ここが知らない型が来ても、型の名前だけは出す。
 *
 * エネルギーやどうぐは、つける先の数だけ手が並ぶ。何をどこへ、まで書かないと見分けられない。
 */
export function describeMove(
  move: Move,
  context: MoveContext,
  placement: DeckPlacementView | null = null,
  destination: AnswerDestination | null = null,
): string {
  const { view, cards } = context;
  const card = (instanceId: string) => cardName(instanceId, context);
  const target = (inPlayId: string) => pokemonLabel(inPlayId, context, false);
  switch (move.type) {
    case "PlayBasic":
      return `${card(move.cardInstanceId)} をベンチに出す`;
    case "Evolve":
      return `${target(move.target)} を ${card(move.cardInstanceId)} に進化させる`;
    case "AttachEnergy":
      return `手札の ${card(move.cardInstanceId)} を ${target(move.target)} につける（手張り）`;
    case "AttachTool":
      return `手札の ${card(move.cardInstanceId)} を ${target(move.target)} につける`;
    case "PlayTrainer": {
      const defId = locateCard(move.cardInstanceId, context)?.defId;
      const verb = defId !== undefined && cards[defId]?.trainerKind === "stadium" ? "出す" : "使う";
      return `${card(move.cardInstanceId)} を${verb}`;
    }
    case "PlayStadiumPair":
      return `${card(move.right)} を出す`;
    case "UseAbility": {
      const found = pokemonAt(move.source, view)?.pokemon;
      const top =
        found === undefined || "concealed" in found ? undefined : found.stack.at(-1)?.defId;
      return `${target(move.source)} の${abilityName(cards, top, move.abilityIndex)}を使う`;
    }
    case "UseHandAbility": {
      const defId = locateCard(move.cardInstanceId, context)?.defId;
      return `手札の ${card(move.cardInstanceId)} の${abilityName(cards, defId, move.abilityIndex)}を使う`;
    }
    case "UseStadiumEffect":
      return "スタジアムの効果を使う";
    case "Retreat":
      return `にげて、${target(move.to)} をバトル場に出す`;
    case "DiscardOwnPokemon":
      return `${target(move.target)} をトラッシュする`;
    case "Attack": {
      const name = attackName(move, context);
      return name === undefined
        ? `${move.attackIndex + 1} 番目のワザを使う`
        : `ワザ「${name}」を使う`;
    }
    case "EndTurn":
      return "番を終わる";
    case "AnswerChoice":
      return describeAnswer(move.answer, context, placement, destination);
    default:
      return (move as { type: string }).type;
  }
}

function abilityName(cards: CardTable, defId: string | undefined, index: number): string {
  const name = defId === undefined ? undefined : cards[defId]?.abilities?.[index];
  return name === undefined ? "特性" : `特性「${name}」`;
}

/**
 * `attackIndex` は印刷されたワザの番号ではなく、どうぐなどで使えるようになったワザを
 * 後ろに足した表の番号である（`engine/docs/spec/engine-core.md` 3.3 節）。印刷されたワザが前に並ぶので、
 * その数より小さければ名前が引ける。
 */
function attackName(
  move: Extract<Move, { type: "Attack" }>,
  { view, cards }: MoveContext,
): string | undefined {
  const side = move.player === view?.viewer ? view.self : view?.opponent;
  const active = side?.active;
  if (active == null || "concealed" in active) return undefined;
  const top = active.stack.at(-1);
  return top === undefined ? undefined : cards[top.defId]?.attacks?.[move.attackIndex];
}

/**
 * 対戦準備の選択への答えの見出し。答えはカードか「はい」「いいえ」だけなので、
 * そのままではバトル場とベンチのどちらに出すのか、「いいえ」で何が起きるのかが読めない。
 */
const SETUP_ANSWERS: Record<string, { card?: string; decline?: string }> = {
  "setup-place-active": { card: "をバトル場に出す", decline: "出さずに手札を引き直す" },
  "setup-place-bench": { card: "をベンチに出す", decline: "ベンチに出し終える" },
  "setup-bonus-draw": { decline: "追加で引かない" },
};

/**
 * 選択の見出し。`ChoiceAnswer` も判別可能ユニオンで、運ぶ値は
 * カード、場の個体、位置、番号のいずれかである。
 * どの選択肢かはサーバが出した順で決まるので、ここでは値そのものを読める形にする。
 */
function describeAnswer(
  answer: ChoiceAnswer,
  context: MoveContext,
  placement: DeckPlacementView | null,
  destination: AnswerDestination | null,
): string {
  const { view, cards } = context;
  const choice = view?.choices.at(-1);
  if (placement !== null && (answer.kind === "card" || answer.kind === "cardDef")) {
    return `${answerCardName(answer, context)} を${placementPlace(placement)}に置く`;
  }
  const setup = choice === undefined ? undefined : SETUP_ANSWERS[choice.kind];
  if (answer.kind === "card" && setup?.card !== undefined) {
    return `${handCardName(answer.card, context)} ${setup.card}`;
  }
  if (answer.kind === "decline" && setup?.decline !== undefined) return setup.decline;
  const moved = destination === null ? null : destinationText(answer, destination, context);
  if (moved !== null) return moved;
  switch (answer.kind) {
    case "accept":
      return "はい";
    case "decline":
      return "いいえ";
    case "card":
      return cardWithPlace(answer.card, context);
    case "cardDef":
      return nameOf(cards, answer.defId);
    case "inPlay":
      return pokemonLabel(answer.target, context, true);
    case "position":
      return `${answer.index + 1} 番目`;
    case "effectIndex":
      return `${answer.index + 1} 番目の効果`;
    case "attackIndex": {
      const listed =
        choice?.prompt?.kind === "selectAttack"
          ? choice.prompt.candidates.find((each) => each.attackIndex === answer.index)
          : undefined;
      return listed === undefined ? `ワザ ${answer.index + 1}` : `ワザ「${listed.label}」`;
    }
    case "placement":
      return answer.placement === "before" ? "先に" : "あとに";
    case "bonusDrawCount":
      return `${answer.count} 枚引く`;
    default:
      return JSON.stringify(answer);
  }
}

function answerCardName(
  answer: Extract<ChoiceAnswer, { kind: "card" | "cardDef" }>,
  context: MoveContext,
): string {
  return answer.kind === "card"
    ? cardWithPlace(answer.card, context)
    : nameOf(context.cards, answer.defId);
}

/**
 * 行き先ごとの言い方。`whose` は、相手のゾーンなら「相手の」、自分のなら空文字。
 * 並びは、あとで決まる行き先を並べる順でもある（手札に加えるが先）。サーバは名前順で送る。
 */
const DESTINATION_PHRASES: Record<string, (whose: string) => string> = {
  hand: (whose) => `${whose}手札に加える`,
  attached: () => "ポケモンにつける",
  evolved: () => "進化させる",
  discard: (whose) => (whose === "" ? "トラッシュする" : "相手のトラッシュに置く"),
  lostZone: (whose) => `${whose}ロストゾーンに置く`,
  deck: (whose) => `${whose}山札にもどす`,
  prizes: (whose) => `${whose}サイドに置く`,
  active: (whose) => `${whose}バトル場に出す`,
  bench: (whose) => `${whose}ベンチに出す`,
};

/**
 * 選んだものの行き先を添えた見出し。書けない組み合わせなら null。
 *
 * 同じ候補から「手札に加える 1 枚」と「ポケモンにつける 1 枚」を続けて選ぶ効果では、
 * カードの名前だけのボタンが 2 回並び、どちらを選んでいるのか分からない。
 */
function destinationText(
  answer: ChoiceAnswer,
  destination: AnswerDestination,
  context: MoveContext,
): string | null {
  if (answer.kind === "inPlay") {
    if (destination.to !== "attached") return null;
    const cardNames = destination.cards.map((defId) => nameOf(context.cards, defId)).join("、");
    return `${cardNames} を ${pokemonLabel(destination.target, context, false)} につける`;
  }
  if (answer.kind !== "card" && answer.kind !== "cardDef") return null;
  const card = answerCardName(answer, context);
  switch (destination.to) {
    case "attached":
      return `${card} を ${pokemonLabel(destination.target, context, false)} につける`;
    case "evolved":
      return `${pokemonLabel(destination.target, context, false)} を ${card} に進化させる`;
    case "later": {
      const phrases = Object.keys(DESTINATION_PHRASES)
        .filter((to) => (destination.options as string[]).includes(to))
        .map((to) => DESTINATION_PHRASES[to]!(""));
      if (phrases.length === 0 || phrases.length !== destination.options.length) return null;
      return phrases.length === 1
        ? `${card} を選ぶ（あとで${phrases[0]}）`
        : `${card} を選ぶ（${phrases.join("か、")}かは、あとで選ぶ）`;
    }
    default: {
      const phrase = DESTINATION_PHRASES[destination.to];
      if (phrase === undefined) return null;
      return `${card} を${phrase(destination.player === context.view?.viewer ? "" : "相手の")}`;
    }
  }
}

/**
 * 選んだカードを山札の端へ順に置く選択の案内。エンジンはカードを 1 枚ずつ選ばせるだけなので、
 * 書かないと、今選んでいるのが何枚目で、先に選んだカードとどちらが上になるのかが分からない。
 */
export function placementPrompt(placement: DeckPlacementView, cards: CardTable): string {
  const above = placement.above.map((defId) => nameOf(cards, defId)).join("、");
  if (placement.edge === "bottom") {
    const note = above === "" ? "" : ` 先に置いた ${above} は、このカードの上になります。`;
    return `山札のいちばん下に置くカードを選んでください。${note}`;
  }
  if (placement.nth === 1) return "山札のいちばん上に置くカードを選んでください。";
  const note =
    placement.above.length === 1
      ? `いちばん上には ${above} を置きました。`
      : `上から ${above} の順に置きました。`;
  return `山札の上から ${placement.nth} 枚目に置くカードを選んでください。${note}`;
}

function placementPlace(placement: DeckPlacementView): string {
  if (placement.edge === "bottom") return "山札のいちばん下";
  return placement.nth === 1 ? "山札のいちばん上" : `山札の上から ${placement.nth} 枚目`;
}

/**
 * 対戦準備で、何を選んでいるのか。
 *
 * まとめて出せないとき（マリガンの追加ドロー、たねが無く特性で出られるカードだけのとき）は、
 * エンジンの選択を 1 つずつ答える。準備は 1 人ずつ進むので、何も書かないと相手の番に移ったように見える。
 */
export function setupPrompt(context: MoveContext, mine: boolean, setup: SetupView | null): string {
  const { view } = context;
  if (view?.phase !== "setup") return "";
  if (setup?.kind === "choose") {
    return "バトル場に出すポケモンを 1 枚と、ベンチに出すたねポケモンを選んで「準備を終える」を押してください。相手に見えるのは、両者が出し終えてからです。";
  }
  if (setup?.kind === "submitted") {
    const bench = setup.bench.map((id) => ownCardName(id, context)).join("、");
    const placed = `バトル場に ${ownCardName(setup.active, context)}${bench === "" ? "" : `、ベンチに ${bench}`}`;
    return `${placed} を出しました。相手の準備を待っています。`;
  }
  if (!mine) return "相手が対戦の準備で選んでいます。";
  const choice = view.choices.at(-1);
  switch (choice?.kind) {
    case "setup-place-active":
      // 選ばずに済むのは、候補が特性でバトル場に出られるカードだけのとき（出さなければ引き直し）。
      return choice.optional
        ? "バトル場に出すポケモンを選んでください。出さなければ手札を引き直します。"
        : "バトル場に出すたねポケモンを選んでください。";
    case "setup-place-bench":
      return "ベンチに出すたねポケモンを選んでください。出し終えたら「ベンチに出し終える」を押します。";
    case "setup-bonus-draw": {
      const max = choice.prompt?.kind === "selectBonusDrawCount" ? choice.prompt.max : undefined;
      return `相手が手札を引き直したので、${max ?? "何"} 枚まで追加で引けます。引いたたねポケモンはベンチに出せます。`;
    }
    default:
      return "";
  }
}

const CARD_FIELDS = new Set(["cardInstanceId", "right", "left", "card"]);

/**
 * 自分の手札の同じカードを選ぶ手を 1 つに畳み、残した手と `legalMoves` での位置を返す。
 * `key` は畳んだ形で、手札のどの 1 枚を代わりに残したかでは変わらない。
 *
 * エンジンは番の中の手では手札の同じカードを畳むが、選択の候補（手札からトラッシュするカードなど）は
 * 1 枚ずつ並べる。畳むのはエンジンと同じく手札だけにする。場やトラッシュのカードは、
 * 同じ `defId` でも個体ごとの記録（どうぐの使用済み、ワザでトラッシュしたエネルギーなど）を持ちうる。
 */
export function foldMoves(
  moves: readonly Move[],
  context: MoveContext,
): { move: Move; index: number; key: string }[] {
  const seen = new Set<string>();
  const shown: { move: Move; index: number; key: string }[] = [];
  for (const [index, move] of moves.entries()) {
    const key = JSON.stringify(move, (field, value: unknown) => {
      if (!CARD_FIELDS.has(field) || typeof value !== "string") return value;
      const found = locateCard(value, context);
      return found?.own === true && found.zone === "hand" ? `hand ${found.defId}` : value;
    });
    if (seen.has(key)) continue;
    seen.add(key);
    shown.push({ move, index, key });
  }
  return shown;
}

/** 手が狙う場のポケモン。ボタンにマウスを載せるか選ぶと、盤面のそのポケモンを囲む。 */
export function moveTargets(move: Move): string[] {
  const fields = move as { target?: unknown; to?: unknown; source?: unknown };
  const answer = move.type === "AnswerChoice" ? (move.answer as { target?: unknown }) : {};
  return [fields.target, fields.to, fields.source, answer.target].filter(
    (id): id is string => typeof id === "string",
  );
}
