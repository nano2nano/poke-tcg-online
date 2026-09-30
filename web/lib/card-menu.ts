/**
 * 盤面のカードを右クリックして、そのカードでできる手をその場に出すための表。
 *
 * 手札の同じカードはボタンの一覧で 1 つに畳むので、手札のカードは種類（`defId`）で引く。
 * 場のポケモンは、使うワザや特性の元、カードをつける先、にげて入れ替わる両方で引く。
 */

import type { Move } from "../../src/engine.js";
import { locateCard, moveTargets, type MoveContext } from "./describe-move.js";

/** 右クリックしたもの。手札のカード、場のポケモン、スタジアムがある。 */
export type MenuSubject = string;

export const handSubject = (defId: string): MenuSubject => `hand ${defId}`;
export const pokemonSubject = (inPlayId: string): MenuSubject => `pokemon ${inPlayId}`;
export const STADIUM_SUBJECT: MenuSubject = "stadium";
export const isHandSubject = (subject: MenuSubject): boolean => subject.startsWith("hand ");

/** 右クリックしたものごとに、そこで指せる手（ボタンの `key`）。 */
export type MenuPlan = ReadonlyMap<MenuSubject, readonly string[]>;

function subjectsOf(move: Move, context: MoveContext): MenuSubject[] {
  const subjects = moveTargets(move).map(pokemonSubject);
  const active = context.view?.self.active;
  if (
    (move.type === "Attack" || move.type === "Retreat") &&
    active != null &&
    "inPlayId" in active
  ) {
    subjects.push(pokemonSubject(active.inPlayId));
  }
  if (move.type === "UseStadiumEffect") subjects.push(STADIUM_SUBJECT);
  const fields = move as { cardInstanceId?: unknown; right?: unknown; left?: unknown };
  for (const instanceId of [fields.cardInstanceId, fields.right, fields.left]) {
    if (typeof instanceId !== "string") continue;
    const card = locateCard(instanceId, context);
    if (card?.own === true && card.zone === "hand") subjects.push(handSubject(card.defId));
  }
  return subjects;
}

export function planMenus(
  buttons: readonly { move: Move; key: string }[],
  context: MoveContext,
): MenuPlan {
  const plan = new Map<MenuSubject, string[]>();
  for (const { move, key } of buttons) {
    for (const subject of new Set(subjectsOf(move, context))) {
      const keys = plan.get(subject) ?? [];
      plan.set(subject, keys);
      keys.push(key);
    }
  }
  return plan;
}

/** 右クリックした要素から、盤面の何を右クリックしたかを引く。盤面の外やカードの無い所は null。 */
export function menuSubjectAt(element: Element): MenuSubject | null {
  if (element.closest(".board") === null) return null;
  const pokemon = element.closest<HTMLElement>("[data-in-play-id]")?.dataset.inPlayId;
  if (pokemon !== undefined) return pokemonSubject(pokemon);
  // 相手の手札は伏せてあり、カードの種類を持たない。
  const card = element.closest<HTMLElement>('[data-zone="hand"] .card[data-def-id]')?.dataset.defId;
  if (card !== undefined) return handSubject(card);
  return element.closest('[data-zone="stadium"]') === null ? null : STADIUM_SUBJECT;
}
