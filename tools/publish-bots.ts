/**
 * 学習の走りの方策を、AI の座席の重み（R2 の `bots/`、仕様 7.3 節）へアップロードし続ける。
 *
 *   npx tsx tools/publish-bots.ts <走りのディレクトリ> [--name=learning] [--every=300] [--keep-every=10] [--local] [--once]
 *
 * 走りの状態（`run-state.json`）が指すいまの方策を見て、変わっていたらアップロードする。いまの方策は、
 * ゲートが昇格を決める走り（`--gate=filter`）ではゲートを通った世代で、落ちた挑戦者は上がらない。
 * ゲートを測るだけの走り（`--gate=measure`）では、ゲートの結果によらず更新がそのまま次の方策になるので、
 * 毎回の更新が上がる。どちらの走りかは起動したときに印字する。アップロードする名前は 2 つある。
 *
 * - `<name>`: いまの方策。アップロードするたびに置き換える。指している最中の対戦は読んだ重みのまま最後まで指す。
 * - `<name>-g<世代>`: 凍結した世代のうち `--keep-every` の倍数を残す。強くなっていく途中の世代と指し比べられる。
 *   出発点の世代も凍結した世代に入っているので残る。0 なら残さない。
 *
 * アップロードする前に、このリポジトリのエンジンで重みを読み、1 手選ばせる。確かめたバイト列をそのまま
 * アップロードする。読めない重み（特徴の語彙が違うエンジンで作ったもの）はアップロードせずに止まる。
 * 本番の Worker も同じエンジンで出したものでないと、アップロードした重みを読めない。
 *
 * 走りの邪魔をしないよう、優先度を最も低くして走り、GPU は使わない。走りのディレクトリには何も書かない。
 * どこまでアップロードしたかは覚えないので、立ち上げ直すと、いまの方策と残す世代をもう一度アップロードする
 * （中身は同じ）。R2 へは `wrangler` でアップロードする。資格情報は手元の `wrangler login` のもの。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BOT_NAME_PATTERN, BOT_PREFIX, botFromBytes, type Bot } from "../src/bots.js";
import {
  createGame,
  derivedView,
  GameKnowledge,
  legalMoves,
  metaDecks,
  playerView,
  registerPoolCards,
} from "../src/engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 走りのディレクトリで、いまの方策を指すファイル。走りは一時ファイルから名前を付け替えて書く。 */
export const RUN_STATE = "run-state.json";

/** 走りの状態のうち、ここで読む欄。 */
export interface RunPointers {
  /** ゲートが昇格を決めるか（`filter`）、測るだけか（`measure`）。 */
  gate: "filter" | "measure";
  /** いまの方策（走りのディレクトリの中のファイル名）。 */
  current: string;
  /** 凍結した世代。出発点と、いまの方策になった世代はすべてここに残る。 */
  anchors: { generation: number; weights: string }[];
}

export function readRunPointers(run: string): RunPointers {
  const path = join(run, RUN_STATE);
  const state = JSON.parse(readFileSync(path, "utf8")) as {
    config?: { gate?: unknown };
    current?: { weights?: unknown };
    anchors?: { generation?: unknown; weights?: unknown }[];
  };
  const gate = state.config?.gate;
  if (gate !== "filter" && gate !== "measure") {
    throw new Error(`${path} のゲートの扱い（config.gate）が filter でも measure でもない`);
  }
  const current = state.current?.weights;
  if (typeof current !== "string") throw new Error(`${path} にいまの方策（current.weights）が無い`);
  const anchors = (state.anchors ?? []).map((one) => {
    if (typeof one.generation !== "number" || typeof one.weights !== "string") {
      throw new Error(`${path} の anchors の形が違う`);
    }
    return { generation: one.generation, weights: one.weights };
  });
  return { gate, current, anchors };
}

export interface Upload {
  /** `bots/` より後ろの名前。 */
  name: string;
  /** 走りのディレクトリの中のファイル名。 */
  weights: string;
}

/**
 * 上げるものを決める。`published` は名前ごとに上げた中身の sha256 で、同じ中身はもう一度上げない。
 * いまの方策を最後に並べる。残す世代を上げている途中で止まっても、いまの方策の名前が古いまま残るだけで済む。
 */
export function plan(
  pointers: RunPointers,
  shaOf: (weights: string) => string,
  published: ReadonlyMap<string, string>,
  options: { name: string; keepEvery: number },
): Upload[] {
  const wanted: Upload[] = [];
  if (options.keepEvery > 0) {
    for (const one of pointers.anchors) {
      if (one.generation % options.keepEvery !== 0) continue;
      wanted.push({ name: `${options.name}-g${one.generation}`, weights: one.weights });
    }
  }
  wanted.push({ name: options.name, weights: pointers.current });
  return wanted.filter((one) => published.get(one.name) !== shaOf(one.weights));
}

/**
 * 重みをこのリポジトリのエンジンで読み、対戦の始まりの局面で 1 手選ばせる。読めなければ投げる。
 * 形式 6 の方策は導出値と追跡器の記憶を要るので、AI の座席と同じ値を作って渡す。
 */
export function checkLoads(name: string, bytes: Uint8Array): Bot {
  const bot = botFromBytes(name, bytes);
  const [first, second] = metaDecks;
  if (first === undefined || second === undefined) throw new Error("デッキの表が 2 本に満たない");
  const decks = [first.deck(), second.deck()] as const;
  const created = createGame({ seed: "0".repeat(32), decks: [decks[0], decks[1]] });
  const state = created.state;
  const seat = state.choices.at(-1)?.owner ?? state.turnPlayer;
  const knowledge = new GameKnowledge(
    [decks[0], decks[1]],
    [seat === 0 && bot.tracksKnowledge, seat === 1 && bot.tracksKnowledge],
  );
  knowledge.observe(created.events);
  const view = playerView(state, seat);
  const legal = legalMoves(state);
  const chosen = bot.choose(view, legal, knowledge.snapshot(seat, view), () => ({
    derived: derivedView(state, seat),
    memory: knowledge.memory(seat, view),
  }));
  if (!(chosen >= 0 && chosen < legal.length)) {
    throw new Error(`${name} が候補 ${legal.length} 個の中から選ばなかった（${chosen}）`);
  }
  return bot;
}

/** `wrangler.jsonc` の R2 のバケット名。AI の座席が重みを読むのと同じバケットへ上げる。 */
function bucketName(): string {
  const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
  const names = [...config.matchAll(/"bucket_name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!);
  if (names.length !== 1) throw new Error("wrangler.jsonc の R2 のバケットが 1 つに決まらない");
  return names[0]!;
}

/** 渡したバイト列をアップロードする。確かめたあとで走りがファイルを書き換えても、確かめた中身が上がる。 */
function upload(bucket: string, name: string, bytes: Uint8Array, local: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), "publish-bots-"));
  const file = join(dir, "weights");
  try {
    writeFileSync(file, bytes);
    putObject(bucket, name, file, local);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function putObject(bucket: string, name: string, file: string, local: boolean): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${BOT_PREFIX}${name}`,
      "--file",
      file,
      "--content-type",
      "application/octet-stream",
      local ? "--local" : "--remote",
    ],
    { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] },
  );
}

interface Options {
  run: string;
  name: string;
  everySeconds: number;
  keepEvery: number;
  local: boolean;
  once: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match === null) positional.push(arg);
    else flags.set(match[1]!, match[2] ?? "");
  }
  const known = new Set(["name", "every", "keep-every", "local", "once"]);
  for (const key of flags.keys()) if (!known.has(key)) throw new Error(`知らないフラグ --${key}`);
  if (positional.length !== 1) throw new Error("走りのディレクトリを 1 つ渡すこと");
  const name = flags.get("name") ?? "learning";
  // 残す世代の名前（`-g<世代>` を足したもの）も名前の形に収まるよう、先に長さを空けておく。
  if (!BOT_NAME_PATTERN.test(`${name}-g99999`)) {
    throw new Error(`--name=${name} は AI の名前に使えない（英数字と . _ -、73 文字まで）`);
  }
  const number = (key: string, fallback: number): number => {
    const value = Number(flags.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 0) throw new Error(`--${key} は 0 以上の整数`);
    return value;
  };
  const everySeconds = number("every", 300);
  if (everySeconds === 0) throw new Error("--every は 1 秒以上");
  return {
    run: resolve(positional[0]!),
    name,
    everySeconds,
    keepEvery: number("keep-every", 10),
    local: flags.has("local"),
    once: flags.has("once"),
  };
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  setPriority(constants.priority.PRIORITY_LOW);
  registerPoolCards();
  const bucket = bucketName();
  const published = new Map<string, string>();
  const seenGate: { value: RunPointers["gate"] | null } = { value: null };
  const where = options.local ? "手元" : "本番";
  console.log(
    `${options.run} のいまの方策を ${where}の ${bucket}/${BOT_PREFIX}${options.name} へアップロードする（${options.everySeconds} 秒ごとに見る）`,
  );
  for (;;) {
    publishOnce(options, bucket, published, seenGate);
    if (options.once) return;
    await sleep(options.everySeconds * 1000);
  }
}

/**
 * 1 回見て、要るものをアップロードする。走りの状態か重みのファイルを読めないとき（走りがまだ始まっていない、
 * 続きの前の片付けで消えた）と、アップロードに失敗したときは、印字して次に見るときにやり直す
 * （`--once` なら投げる）。重みをエンジンが読めないときは、次に見ても読めないので投げる。
 */
function publishOnce(
  options: Options,
  bucket: string,
  published: Map<string, string>,
  seenGate: { value: RunPointers["gate"] | null },
): void {
  const retry = (what: string, error: unknown): void => {
    if (options.once) throw error;
    console.log(`${clock()} ${what}。次に見るときにやり直す: ${messageOf(error)}`);
  };
  let pointers: RunPointers;
  try {
    pointers = readRunPointers(options.run);
  } catch (error) {
    retry("走りの状態を読めない", error);
    return;
  }
  if (seenGate.value !== pointers.gate) {
    seenGate.value = pointers.gate;
    console.log(
      pointers.gate === "filter"
        ? "ゲートが昇格を決める走り。ゲートを通った世代だけがいまの方策になる"
        : "ゲートを測るだけの走り。ゲートの結果によらず、毎回の更新がいまの方策になる",
    );
  }
  const files = new Map<string, { bytes: Buffer; sha256: string }>();
  const read = (weights: string): { bytes: Buffer; sha256: string } => {
    let file = files.get(weights);
    if (file === undefined) {
      const bytes = readFileSync(join(options.run, weights));
      file = { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
      files.set(weights, file);
    }
    return file;
  };
  let uploads: Upload[];
  try {
    uploads = plan(pointers, (weights) => read(weights).sha256, published, options);
  } catch (error) {
    retry("重みのファイルを読めない", error);
    return;
  }
  for (const one of uploads) {
    const { bytes, sha256 } = read(one.weights);
    const bot = checkLoads(one.name, bytes);
    try {
      upload(bucket, one.name, bytes, options.local);
    } catch (error) {
      retry(`${one.name} をアップロードできなかった`, error);
      return;
    }
    published.set(one.name, sha256);
    console.log(
      `${clock()} ${one.name} ← ${bot.identity.label}（世代 ${bot.identity.generation}、sha256 ${sha256.slice(0, 12)}）`,
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(messageOf(error));
    process.exit(1);
  });
}
