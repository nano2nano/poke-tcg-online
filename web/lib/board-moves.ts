/**
 * 局面が変わったときに、盤面のどのカードをどこからどこへ動かして見せるかを決める。
 *
 * 射影は山札・サイド・伏せた手札のカードの ID を持たないので、そこへ出入りしたカードは、前後の局面の
 * 枚数の増減から場所を決める。決まらないときは動かさない。違う場所から動かすと、起きたことを取り違えさせる。
 */

import type { CardInstance, PlayerEvent, Player, SpectatorView } from "../../src/engine.js";
import type { Side } from "./describe.js";

export type BoardSide = "near" | "far";

export interface BoardSides {
  near: Side | null;
  far: Side | null;
  stadium: SpectatorView["stadium"];
}

/** カードを 1 枚ずつは描かない場所。山札、サイド、伏せた手札と、上の 1 枚だけを描くトラッシュとロストゾーン。 */
export interface Place {
  side: BoardSide;
  zone: "deck" | "prizes" | "hand" | "discard" | "lost";
}

/** `order` は、同じ場所から（へ）この局面で動く何枚目か。少しずつずらして動かし、枚数を見せる。 */
export interface Move {
  place: Place;
  order: number;
}

export interface BoardMoves {
  /** 前の局面で描いていなかったカードが、どこから来たか。 */
  arrivals: ReadonlyMap<string, Move>;
  /** 前の局面で描いていたカードが、どこへ行ったか。 */
  departures: ReadonlyMap<string, Move>;
  /** 伏せた手札で、この局面に引いたカードの位置（何枚目から）と来た場所。 */
  backs: Partial<Record<BoardSide, { from: number; zone: "deck" | "prizes" }>>;
  /** 山札を切った側。 */
  shuffled: readonly BoardSide[];
}

export const NO_MOVES: BoardMoves = {
  arrivals: new Map(),
  departures: new Map(),
  backs: {},
  shuffled: [],
};

/** 山札を切った座席。同じ局面で 2 度切っても 1 度にする。 */
export function shuffledDecks(events: readonly PlayerEvent[]): Player[] {
  const players = events.flatMap((event) => (event.kind === "deck-shuffled" ? [event.player] : []));
  return [...new Set(players)];
}

type Pokemon = Extract<NonNullable<Side["active"]>, { inPlayId: string }>;

/** 盤面でカードが見えている場所。ポケモンの重なりの下のカードも、場に数える。 */
type Seen = { side: BoardSide | null; zone: "hand" | "field" | "discard" | "lost" | "stadium" };

const SIDES = ["near", "far"] as const;

function pokemonOf(side: Side): Pokemon[] {
  return [side.active, ...side.bench].filter(
    (each): each is Pokemon => each !== null && "inPlayId" in each,
  );
}

function stadiumCards(stadium: SpectatorView["stadium"]): CardInstance[] {
  if (stadium === null) return [];
  return "instanceId" in stadium ? [stadium] : [stadium.left, stadium.right];
}

/** 射影に ID が載っているカードと、その場所。 */
function seenPlaces(sides: BoardSides): Map<string, Seen> {
  const seen = new Map<string, Seen>();
  const put = (cards: readonly CardInstance[], place: Seen) => {
    for (const card of cards) seen.set(card.instanceId, place);
  };
  for (const name of SIDES) {
    const side = sides[name];
    if (side === null) continue;
    if ("hand" in side) put(side.hand, { side: name, zone: "hand" });
    put(side.discard, { side: name, zone: "discard" });
    put(side.lostZone, { side: name, zone: "lost" });
    for (const pokemon of pokemonOf(side)) {
      put([...pokemon.stack, ...pokemon.attached], { side: name, zone: "field" });
    }
  }
  put(stadiumCards(sides.stadium), { side: null, zone: "stadium" });
  return seen;
}

/** 盤面に 1 枚ずつ描くカード。山は上の 1 枚、ポケモンは重なりのいちばん上とついているカードだけを描く。 */
function drawnIds(sides: BoardSides): Set<string> {
  const ids: CardInstance[] = stadiumCards(sides.stadium);
  for (const name of SIDES) {
    const side = sides[name];
    if (side === null) continue;
    if ("hand" in side) ids.push(...side.hand);
    for (const pile of [side.discard, side.lostZone]) {
      const top = pile.at(-1);
      if (top !== undefined) ids.push(top);
    }
    for (const pokemon of pokemonOf(side)) ids.push(pokemon.stack.at(-1)!, ...pokemon.attached);
  }
  return new Set(ids.map((card) => card.instanceId));
}

export function handCount(side: Side): number {
  return "hand" in side ? side.hand.length : side.handCount;
}

interface Counts {
  deck: number;
  prizes: number;
  /** 中身が見える手札は、カードの ID で追えるので 0 にする。 */
  hiddenHand: number;
}

export function boardMoves(
  before: BoardSides,
  after: BoardSides,
  shuffled: readonly BoardSide[],
): BoardMoves {
  const [was, now] = [drawnIds(before), drawnIds(after)];
  const [seenBefore, seenAfter] = [seenPlaces(before), seenPlaces(after)];
  const counted = new Map<string, number>();
  const move = (direction: string, place: Place): Move => {
    const key = `${direction} ${place.side} ${place.zone}`;
    const order = counted.get(key) ?? 0;
    counted.set(key, order + 1);
    return { place, order };
  };
  const changes: Partial<Record<BoardSide, Counts>> = {};
  for (const name of SIDES) {
    const [from, to] = [before[name], after[name]];
    if (from === null || to === null) continue;
    changes[name] = {
      deck: to.deckCount - from.deckCount,
      prizes: to.prizeCount - from.prizeCount,
      hiddenHand: "hand" in to ? 0 : to.handCount - handCount(from),
    };
  }

  const departures = new Map<string, Move>();
  for (const id of was) {
    if (now.has(id)) continue;
    const at = seenAfter.get(id);
    const from = seenBefore.get(id)!;
    let place: Place | null = null;
    if (at?.zone === "discard" || at?.zone === "lost") {
      // 山の上に別のカードが載っただけなら、動いていない。
      const stayed = at.side === from.side && at.zone === from.zone;
      if (!stayed && at.side !== null) place = { side: at.side, zone: at.zone };
    } else if (at === undefined && from.side !== null && changes[from.side] !== undefined) {
      const counts = changes[from.side]!;
      const into = [
        counts.prizes > 0 && ("prizes" as const),
        counts.deck > 0 && ("deck" as const),
        counts.hiddenHand > 0 && ("hand" as const),
      ].filter((each) => each !== false);
      // 山札を切った側では、手札を山札へもどして同じ枚数を引くと、山札の枚数が変わらない。
      // 見えている手札のカードが見えなくなる先は、山札のほかにはサイドしかない。
      const refilled = into.length === 0 && from.zone === "hand" && shuffled.includes(from.side);
      const zone = into.length === 1 ? into[0]! : refilled ? "deck" : null;
      if (zone !== null) place = { side: from.side, zone };
    }
    if (place !== null) departures.set(id, move("to", place));
  }

  const intoDeck = new Set(
    [...departures.values()].flatMap(({ place }) => (place.zone === "deck" ? [place.side] : [])),
  );
  /** 見えていなかったカードが、その側のどこから出てきうるか。 */
  const sources: Partial<Record<BoardSide, Place["zone"][]>> = {};
  for (const name of SIDES) {
    const counts = changes[name];
    if (counts === undefined) continue;
    sources[name] = [
      counts.prizes < 0 && ("prizes" as const),
      (counts.deck < 0 || intoDeck.has(name)) && ("deck" as const),
      counts.hiddenHand < 0 && ("hand" as const),
    ].filter((each) => each !== false);
  }
  // スタジアムはどちらの側にも置かれないので、伏せた手札からだけ出せた側が片方だけのときに限る。
  const stadiumFrom = SIDES.filter((name) => sources[name]?.join() === "hand");

  const arrivals = new Map<string, Move>();
  for (const id of now) {
    if (was.has(id)) continue;
    const at = seenAfter.get(id)!;
    const from = seenBefore.get(id);
    let place: Place | null = null;
    if ((from?.zone === "discard" || from?.zone === "lost") && from.side !== null) {
      place = { side: from.side, zone: from.zone };
    } else if (from === undefined && at.side === null) {
      if (stadiumFrom.length === 1) place = { side: stadiumFrom[0]!, zone: "hand" };
    } else if (from === undefined && at.side !== null) {
      const out = sources[at.side] ?? [];
      if (out.length === 1) place = { side: at.side, zone: out[0]! };
    }
    if (place !== null) arrivals.set(id, move("from", place));
  }

  const backs: BoardMoves["backs"] = {};
  for (const name of SIDES) {
    const [to, counts] = [after[name], changes[name]];
    if (to === null || counts === undefined || counts.hiddenHand <= 0) continue;
    if (counts.prizes < 0 === counts.deck < 0) continue;
    // 手札から出したカードがあると、手札の増えた数は引いた数より少ない。減った山札かサイドの数だけ動かす。
    const drawn = -(counts.prizes < 0 ? counts.prizes : counts.deck);
    backs[name] = {
      from: Math.max(handCount(to) - drawn, 0),
      zone: counts.prizes < 0 ? "prizes" : "deck",
    };
  }
  return { arrivals, departures, backs, shuffled };
}
