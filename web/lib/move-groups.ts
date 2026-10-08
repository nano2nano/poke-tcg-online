/**
 * 指せる手を種類ごとに分けて並べる。にげる、つける、ワザが 1 列に同じ形で並ぶと、押し間違える。
 *
 * つける先やにげる先だけが違う手は 1 つにまとめ、押したら盤面で先のポケモンを選ばせる。先を選ぶまでは
 * 何も送らないので、やめても手を指したことにはならない。
 */

import type { Move } from "../../src/engine.js";
import { handCardName, type MoveContext } from "./describe-move.js";

/** 盤面のポケモンを押して先を選ぶ手。押したポケモン（`inPlayId`）で指す手を引く。 */
export interface TargetPick {
  prompt: string;
  moves: ReadonlyMap<string, Move>;
}

export type MoveKind = "play" | "attach" | "ability" | "other" | "retreat" | "attack";

/** 並べる順と見出し。番が終わるワザを最後に置き、ほかの手と離す。 */
const KINDS: readonly { kind: MoveKind; title: string }[] = [
  { kind: "play", title: "手札から出す・使う" },
  { kind: "attach", title: "つける・進化させる" },
  { kind: "ability", title: "特性" },
  { kind: "other", title: "そのほか" },
  { kind: "retreat", title: "にげる" },
  { kind: "attack", title: "ワザ（使うと番が終わる）" },
];

/** そのまま指す手（`button`）か、盤面で先を選ばせる手（`pick`）。 */
export interface MoveEntry<T> {
  key: string;
  label: string;
  button?: T;
  pick?: TargetPick;
}

export interface MoveGroup<T> {
  kind: MoveKind;
  title: string;
  entries: MoveEntry<T>[];
}

function kindOf(move: Move): MoveKind {
  switch (move.type) {
    case "PlayBasic":
    case "PlayTrainer":
    case "PlayStadiumPair":
      return "play";
    case "AttachEnergy":
    case "AttachTool":
    case "Evolve":
      return "attach";
    case "UseAbility":
    case "UseHandAbility":
      return "ability";
    case "Retreat":
      return "retreat";
    case "Attack":
      return "attack";
    default:
      return "other";
  }
}

/** 先のポケモンだけが違う手をまとめたときのキー。まとめない手は null。 */
export function pickKey(move: Move): string | null {
  switch (move.type) {
    case "Retreat":
      return "pick retreat";
    case "AttachEnergy":
    case "AttachTool":
    case "Evolve":
      return `pick ${move.type} ${move.cardInstanceId}`;
    default:
      return null;
  }
}

function targetOf(move: Move): string {
  if (move.type === "Retreat") return move.to;
  return (move as Extract<Move, { target: string }>).target;
}

function pickText(move: Move, context: MoveContext): { label: string; prompt: string } {
  const card = "cardInstanceId" in move ? handCardName(move.cardInstanceId, context) : "";
  switch (move.type) {
    case "Retreat":
      return { label: "にげる", prompt: "にげて、バトル場に出すポケモンを選んでください" };
    case "Evolve":
      return {
        label: `${card} に進化させる`,
        prompt: `${card} に進化させるポケモンを選んでください`,
      };
    default:
      return {
        label: `手札の ${card} をつける${move.type === "AttachEnergy" ? "（手張り）" : ""}`,
        prompt: `${card} をつけるポケモンを選んでください`,
      };
  }
}

/**
 * 種類ごとに分け、先だけが違う手をまとめる。種類の中は、エンジンが出した順のままにする。
 *
 * にげる手は先が 1 匹でもまとめ、にげたあとにバトル場に出るポケモンを盤面で見て選ばせる。
 * `chosen` は、押して手を出したポケモン。そのポケモンへにげる手は、先をもう選んであるのでまとめない。
 */
export function groupMoves<T extends { move: Move; key: string; label: string }>(
  buttons: readonly T[],
  context: MoveContext,
  chosen: string | null = null,
): MoveGroup<T>[] {
  const bundles = new Map<string, T[]>();
  for (const button of buttons) {
    const key = pickKey(button.move);
    if (key === null) continue;
    const bundle = bundles.get(key);
    if (bundle === undefined) bundles.set(key, [button]);
    else bundle.push(button);
  }
  const groups = KINDS.map(({ kind, title }) => ({ kind, title, entries: [] as MoveEntry<T>[] }));
  const added = new Set<string>();
  for (const button of buttons) {
    const { move } = button;
    const { entries } = groups.find(({ kind }) => kind === kindOf(move))!;
    const key = pickKey(move);
    const bundle = key === null ? [button] : bundles.get(key)!;
    const picked = move.type !== "Retreat" || targetOf(move) === chosen;
    if (key === null || (bundle.length === 1 && picked)) {
      entries.push({ key: button.key, label: button.label, button });
      continue;
    }
    if (added.has(key)) continue;
    added.add(key);
    const moves = new Map(bundle.map((each) => [targetOf(each.move), each.move]));
    const { label, prompt } = pickText(move, context);
    entries.push({ key, label: `${label}…`, pick: { prompt, moves } });
  }
  return groups.filter(({ entries }) => entries.length > 0);
}
