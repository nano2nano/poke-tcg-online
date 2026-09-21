/**
 * 人が書いたデッキの文字列を `defId` の列へ解決する（`docs/spec/battle-server.md` 5.3 節）。
 *
 * **名前からの解決は一意に決まらない。** 正規データには同じ名前で `defId` が違う定義が
 * たくさんあり（実測で名前 1,470 種のうち 455 種、定義の 53.3%、最大 34 通り）、
 * その大半はポケモンである。同じ名前でも HP もワザも違う別のカードなので、
 * **推測で 1 つ選んではならない。** 選べないときは候補を返して拒否する。
 *
 * 解決は提出の時点で 1 度だけ行い、**そこから先は解決済みの `defId` 列だけを唯一の情報源とする**。
 * 対局ログに残るのもこの列である（6.2 節）。インスタンス ID がデッキ配列の添字である以上、
 * 順序まで含めて一致しなければ再生できない。
 */

import type { CardDef, CardDefId, DeckList } from "./engine.js";
import { getCardDef, loadGeneratedCards } from "./engine.js";
import { DECK_SIZE } from "./deck.js";

/** 1 度に読む行数の上限。これを越える入力は、デッキではない。 */
const MAX_LINES = 200;

/** 同名 4 枚制限は `validateDeck` が見る。ここで見るのは、配列が爆発しない範囲かどうかだけ。 */
const MAX_COUNT_PER_LINE = DECK_SIZE;

/** 同じ名前の候補を見分けるための値。表示の仕方はクライアントが決める。 */
export interface CardChoice {
  defId: CardDefId;
  kind: string;
  /** ポケモンだけ。同名の版はここが違う。 */
  hp?: number;
  stage?: "basic" | "stage1" | "stage2";
  /** 収録。公式の表記そのまま。 */
  set?: string;
  number?: string;
}

export interface ResolvedEntry {
  name: string;
  count: number;
  defId: CardDefId;
}

export type DecklistFailure =
  | { kind: "too-many-lines"; actual: number }
  | { kind: "unparsable"; line: number; text: string }
  | { kind: "bad-count"; line: number; name: string; count: number }
  | { kind: "unknown-name"; line: number; name: string }
  | { kind: "ambiguous"; line: number; name: string; choices: CardChoice[] }
  | { kind: "unknown-defId"; line: number; defId: CardDefId }
  | { kind: "name-mismatch"; line: number; name: string; defId: CardDefId; actual: string };

export type DecklistResult =
  | { ok: true; deck: DeckList; entries: ResolvedEntry[] }
  | { ok: false; failures: DecklistFailure[] };

/**
 * 1 行 1 種類で読む。受ける形は 3 つ。
 *
 * - `名前 枚数`
 * - `枚数 名前`
 * - `名前 枚数 defId`（同じ名前が複数あるときに、どれかを指定する形）
 *
 * 空行と `#` で始まる行は読み飛ばす。見出しの行（「ポケモン 12」など）は
 * カード名として解決できないので `unknown-name` になる。**読み飛ばす語を持たないのは、
 * カードの語彙をこのリポジトリへ書き込まないためである。**
 */
export function resolveDecklist(text: string): DecklistResult {
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    return { ok: false, failures: [{ kind: "too-many-lines", actual: lines.length }] };
  }

  const failures: DecklistFailure[] = [];
  const entries: ResolvedEntry[] = [];

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const trimmed = normalize(raw).trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const parsed = parseLine(trimmed);
    if (parsed === null) {
      failures.push({ kind: "unparsable", line, text: trimmed });
      continue;
    }
    if (parsed.count < 1 || parsed.count > MAX_COUNT_PER_LINE) {
      failures.push({ kind: "bad-count", line, name: parsed.name, count: parsed.count });
      continue;
    }

    const defId = resolveOne(parsed, line, failures);
    if (defId !== null) entries.push({ name: parsed.name, count: parsed.count, defId });
  }

  if (failures.length > 0) return { ok: false, failures };

  const cards: CardDefId[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i++) cards.push(entry.defId);
  }
  return { ok: true, deck: { cards }, entries };
}

/** 解決できた 1 行を `defId` にする。できなければ `failures` へ積んで null を返す。 */
function resolveOne(
  parsed: ParsedLine,
  line: number,
  failures: DecklistFailure[],
): CardDefId | null {
  if (parsed.defId !== null) {
    const def = lookupDefId(parsed.defId);
    if (def === null) {
      failures.push({ kind: "unknown-defId", line, defId: parsed.defId });
      return null;
    }
    // 名前と `defId` の組がずれていたら、どちらが本意か分からないので拒否する。
    if (def.name !== parsed.name) {
      failures.push({
        kind: "name-mismatch",
        line,
        name: parsed.name,
        defId: parsed.defId,
        actual: def.name,
      });
      return null;
    }
    return def.defId;
  }

  const candidates = byName().get(parsed.name) ?? [];
  const only = candidates[0];
  if (only === undefined) {
    failures.push({ kind: "unknown-name", line, name: parsed.name });
    return null;
  }
  if (candidates.length > 1) {
    failures.push({
      kind: "ambiguous",
      line,
      name: parsed.name,
      choices: candidates.map(choiceOf),
    });
    return null;
  }
  return only.defId;
}

interface ParsedLine {
  name: string;
  count: number;
  defId: CardDefId | null;
}

function parseLine(text: string): ParsedLine | null {
  const tokens = text.split(/\s+/).filter((token) => token !== "");
  if (tokens.length < 2) return null;

  const last = tokens[tokens.length - 1] as string;
  const first = tokens[0] as string;

  // `名前 枚数`
  if (isCount(last)) {
    return { name: tokens.slice(0, -1).join(" "), count: Number(last), defId: null };
  }
  // `名前 枚数 defId`
  const secondLast = tokens[tokens.length - 2];
  if (tokens.length >= 3 && secondLast !== undefined && isCount(secondLast)) {
    return { name: tokens.slice(0, -2).join(" "), count: Number(secondLast), defId: last };
  }
  // `枚数 名前`
  if (isCount(first)) {
    return { name: tokens.slice(1).join(" "), count: Number(first), defId: null };
  }
  return null;
}

function isCount(token: string): boolean {
  return /^[0-9]+$/.test(token);
}

/** 全角の数字と空白を、半角へ直す。日本語入力ではどちらも普通に混ざる。 */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

let nameIndex: Map<string, CardDef[]> | null = null;

/** 名前 → 定義。候補の並びは `defId` の昇順で、入力が同じなら結果も同じになる（D-4）。 */
function byName(): Map<string, CardDef[]> {
  if (nameIndex !== null) return nameIndex;
  const built = new Map<string, CardDef[]>();
  for (const def of loadGeneratedCards()) {
    built.set(def.name, [...(built.get(def.name) ?? []), def]);
  }
  for (const defs of built.values()) defs.sort((a, b) => (a.defId < b.defId ? -1 : 1));
  nameIndex = built;
  return built;
}

function lookupDefId(defId: CardDefId): CardDef | null {
  try {
    return getCardDef(defId);
  } catch {
    return null;
  }
}

function choiceOf(def: CardDef): CardChoice {
  const print = def.prints[0];
  return {
    defId: def.defId,
    kind: def.kind,
    ...(def.kind === "pokemon" ? { hp: def.hp, stage: def.evolutionStage } : {}),
    ...(print === undefined ? {} : { set: print.set }),
    ...(print?.number == null ? {} : { number: print.number }),
  };
}

export function describeDecklistFailure(failure: DecklistFailure): string {
  switch (failure.kind) {
    case "too-many-lines":
      return `行が多すぎる（${failure.actual} 行）`;
    case "unparsable":
      return `${failure.line} 行目を読めない: ${failure.text}`;
    case "bad-count":
      return `${failure.line} 行目の枚数が範囲の外: ${failure.name} が ${failure.count} 枚`;
    case "unknown-name":
      return `${failure.line} 行目のカードが見つからない: ${failure.name}`;
    case "ambiguous":
      return `${failure.line} 行目の ${failure.name} は ${failure.choices.length} 通りある。どれか 1 つを選ぶこと`;
    case "unknown-defId":
      return `${failure.line} 行目の指定が見つからない: ${failure.defId}`;
    case "name-mismatch":
      return `${failure.line} 行目の名前と指定が食い違う: ${failure.name} と ${failure.defId}（${failure.actual}）`;
  }
}
