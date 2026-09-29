/**
 * 手札のカードを盤面へ落として手を指すための表。どのカードをどこへ落とせば、どの手になるか。
 *
 * 手札の同じカードはボタンの一覧で 1 つに畳むので、どの 1 枚をつかんでも同じ手になるよう、
 * カードの種類（`defId`）で引く。表を作るのはボタンの一覧からで、盤面の判断はしない。
 */

import type { Move } from "../../src/engine.js";
import { locateCard, type MoveContext } from "./describe-move.js";

/** 落とす先。場のポケモン、自分のバトル場とベンチ、カードを使う場所（盤面の真ん中）がある。 */
export type DropSpot = string;

/** カードの種類ごとに、落とす先と、そこへ落としたときに指せる手（ボタンの `key`）。 */
export type DropPlan = ReadonlyMap<string, ReadonlyMap<DropSpot, readonly string[]>>;

export const NO_DROPS: DropPlan = new Map();

export const pokemonSpot = (inPlayId: string): DropSpot => `pokemon ${inPlayId}`;
export const ACTIVE_SPOT: DropSpot = "active";
export const BENCH_SPOT: DropSpot = "bench";
export const PLAY_SPOT: DropSpot = "play";

/** 手札から持っていくカードと、落とす先。手札のカードを使わない手は null。 */
function dropOf(move: Move): [cards: string[], spot: DropSpot] | null {
  switch (move.type) {
    case "PlayBasic":
      return move.to.kind === "bench"
        ? [[move.cardInstanceId], BENCH_SPOT]
        : move.to.kind === "active"
          ? [[move.cardInstanceId], ACTIVE_SPOT]
          : null;
    case "Evolve":
    case "AttachEnergy":
    case "AttachTool":
      return [[move.cardInstanceId], pokemonSpot(move.target)];
    case "PlayTrainer":
      return [[move.cardInstanceId], PLAY_SPOT];
    case "PlayStadiumPair":
      return [[move.right, move.left], PLAY_SPOT];
    default:
      return null;
  }
}

export function planDrops(
  buttons: readonly { move: Move; key: string }[],
  context: MoveContext,
): DropPlan {
  const plan = new Map<string, Map<DropSpot, string[]>>();
  for (const { move, key } of buttons) {
    const drop = dropOf(move);
    if (drop === null) continue;
    const [cards, spot] = drop;
    for (const instanceId of cards) {
      const card = locateCard(instanceId, context);
      if (card === null || !card.own || card.zone !== "hand") continue;
      const spots = plan.get(card.defId) ?? new Map<DropSpot, string[]>();
      plan.set(card.defId, spots);
      const keys = spots.get(spot) ?? [];
      spots.set(spot, keys);
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return plan.size === 0 ? NO_DROPS : plan;
}
