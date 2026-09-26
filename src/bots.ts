/**
 * AI の座席（`docs/spec/battle-server.md` 7.3 節）。
 *
 * 学習した方策の重みを R2 の `bots/` に置き、名前で引いて片方の座席に座らせる。
 * 方策が受け取るのは座席の射影（`viewFor`）と合法手、それにその座席へ射影したイベントから追った
 * 自分の伏せたカードの知識で、人の座席に届くもの以上は見ない。
 * 手はサーバの中で選び、人の手と同じ `submitMove` を通す。
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types/index.ts";
import {
  decodeEntityWeights,
  decodePpoWeights,
  ENTITY_MAGIC,
  metaDecks,
  policyOf,
  PPO_MAGIC,
  probabilitiesOf,
  sampleFrom,
  tracksKnowledge,
  type CardDefId,
  type DecisionExtras,
  type DeckList,
  type HiddenKnowledge,
  type Move,
  type PlayerView,
  type PolicyFile,
} from "./engine.js";

/** 重みの保存先。対局ログ（`matches/`）と同じバケットの別の接頭辞である。 */
export const BOT_PREFIX = "bots/";

/** 名前はキーの接頭辞より後ろそのもの。URL と画面にそのまま出るので、使える文字を絞る。 */
export const BOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** 座席の `playerId` の頭。プレイヤーの識別子は UUID なので、人と重ならない。 */
export const BOT_PLAYER_PREFIX = "bot:";

/**
 * 対局ログに残す、どの重みが指したか（6.2 節の `seats[].bot`）。
 * 名前は置き換えられるので、中身のハッシュも残す。同じ名前で別の重みを置いても、記録から見分けられる。
 */
export interface BotIdentity {
  name: string;
  label: string;
  generation: number;
  weightsSha256: string;
}

export interface Bot {
  identity: BotIdentity;
  /**
   * 自分の伏せたカード（山札とサイド）の知識を入力に使う方策か。使う方策には、対戦が座席の追跡器を持って
   * `choose` へ渡す。使わない方策へ渡した知識は、方策の側が捨てる。
   */
  tracksKnowledge: boolean;
  /**
   * 候補の中から 1 つ選び、その位置を返す。`extras` は要素の集合を読む方策（形式 6）だけが呼ぶ。
   * 導出値は重いので、ほかの方策のためには作らない。
   */
  choose(
    view: PlayerView,
    legal: readonly Move[],
    knowledge: HiddenKnowledge,
    extras: () => DecisionExtras,
  ): number;
}

/**
 * 重みのバイト列から AI を作る。形式の見分け方はエンジンの `readWeightsFile` と同じで、
 * 形式 5 と形式 6 は先頭の印で、それ以外は JSON として読む。読めなければ投げる。
 *
 * 手は方策の確率どおりに引く。自己対戦とゲートが指すのと同じ選び方なので、
 * 学習の記録に出ている強さのまま指す。最も確率の高い手だけを指すと、別の方策になる。
 */
export function botFromBytes(
  name: string,
  bytes: Uint8Array,
  uniform: () => number = cryptoUniform,
): Bot {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const source = `${BOT_PREFIX}${name}`;
  const file: PolicyFile = startsWith(buffer, PPO_MAGIC)
    ? decodePpoWeights(buffer, source)
    : startsWith(buffer, ENTITY_MAGIC)
      ? decodeEntityWeights(buffer, source)
      : (JSON.parse(buffer.toString("utf8")) as PolicyFile);
  const policy = policyOf(file);
  return {
    identity: {
      name,
      label: file.label,
      generation: file.generation,
      weightsSha256: createHash("sha256").update(buffer).digest("hex"),
    },
    tracksKnowledge: tracksKnowledge(policy),
    choose: (view, legal, knowledge, extras) =>
      sampleFrom(
        probabilitiesOf(policy, () => view, legal, knowledge, extras),
        uniform(),
      ),
  };
}

function startsWith(buffer: Buffer, magic: string): boolean {
  return buffer.subarray(0, magic.length).toString("latin1") === magic;
}

/** [0, 1) の一様乱数。対戦の種とは別の出どころにする。AI の選び方が種の列を進めない。 */
function cryptoUniform(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] as number) / 2 ** 32;
}

export interface BotEntry {
  name: string;
  size: number;
  uploadedAt: string;
}

export type BotLoad = { ok: true; bot: Bot } | { ok: false; error: string };

/**
 * 読んだ重みをキャッシュに持つ数。キャッシュの重みはそれぞれ Durable Object のメモリを占めるので、数を絞る。
 * キャッシュに無い重みは R2 から読み直す。
 */
const LOADED_LIMIT = 4;

/**
 * 一覧を覚えておく長さ。一覧はだれでも頼めるので、頼まれるたびに R2 を並べると、
 * 回数で課金される操作を外から好きなだけ使わせることになる。
 */
const LIST_TTL_MS = 10_000;

/** 重み 1 本の読み込みを待つ上限。これを越えたら、読み込みが返ってこないものとして諦める。 */
const LOAD_TIMEOUT_MS = 30_000;

export class BotStore {
  /** キャッシュ。名前 → 読んだときの etag と AI。置き換えられた重みは etag で見分けて読み直す。 */
  private readonly loaded = new Map<string, { etag: string; bot: Bot }>();
  /**
   * 名前と重みのハッシュ → まだどこかの対戦が使っている AI。上のキャッシュから落ちても、
   * 生きている対戦が持っている AI は作り直さずに渡す。作り直すと、同じ重みの写しが対戦の数だけメモリに並ぶ。
   */
  private readonly alive = new Map<string, WeakRef<Bot>>();
  private listed: { atMs: number; entries: Promise<BotEntry[]> } | null = null;
  /**
   * 読み込みを 1 本ずつ並べる。形式 5 の読み込みは Durable Object を止め、読んでいるあいだは重みのバイト列を抱える。
   * 並べれば、同時に何本頼まれても抱えるのは 1 本で（上限で諦めた読み込みが残っていなければ）、
   * 同じ重みは 2 本目からキャッシュを使う。
   */
  private loading: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bucket: R2Bucket,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 並べている途中の一覧も覚える。空のときに同時に頼まれても、R2 を並べるのは 1 回である。 */
  list(): Promise<BotEntry[]> {
    const nowMs = this.now();
    if (this.listed !== null && nowMs - this.listed.atMs < LIST_TTL_MS) return this.listed.entries;
    const entries = this.listAll();
    const listed = { atMs: nowMs, entries };
    this.listed = listed;
    // 失敗は覚えない。次に頼まれたときに並べ直す。
    entries.catch(() => {
      if (this.listed === listed) this.listed = null;
    });
    return entries;
  }

  private async listAll(): Promise<BotEntry[]> {
    const entries: BotEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: BOT_PREFIX,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const object of page.objects) {
        const name = object.key.slice(BOT_PREFIX.length);
        if (!BOT_NAME_PATTERN.test(name)) continue;
        entries.push({ name, size: object.size, uploadedAt: object.uploaded.toISOString() });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
    return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  load(name: string): Promise<BotLoad> {
    // 返ってこない R2 の読み込みが 1 つあると、並んだ後ろの読み込みが全部止まる。待つのに上限を置く。
    // 諦めた読み込みは止められないので、それが返るまでは次の読み込みと同時に走る。
    const run = this.loading.then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<BotLoad>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, error: `AI「${name}」の重みを読み終えられなかった` }),
          LOAD_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([this.loadNow(name), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    });
    this.loading = run.catch(() => undefined);
    return run;
  }

  private async loadNow(name: string): Promise<BotLoad> {
    if (!BOT_NAME_PATTERN.test(name)) return { ok: false, error: "AI の名前の形が違う" };
    const key = `${BOT_PREFIX}${name}`;
    const head = await this.bucket.head(key);
    if (head === null) return { ok: false, error: `AI「${name}」が置かれていない` };
    const cached = this.loaded.get(name);
    if (cached?.etag === head.etag) {
      // 使った順に並べ直す。溢れたときに捨てるのは先頭（いちばん長く使っていないもの）である。
      this.loaded.delete(name);
      this.loaded.set(name, cached);
      return { ok: true, bot: cached.bot };
    }
    const object = await this.bucket.get(key);
    if (object === null) return { ok: false, error: `AI「${name}」が置かれていない` };
    const bytes = new Uint8Array(await object.arrayBuffer());
    const aliveKey = `${name}\n${createHash("sha256").update(bytes).digest("hex")}`;
    let bot = this.alive.get(aliveKey)?.deref();
    if (bot === undefined) {
      try {
        bot = botFromBytes(name, bytes);
      } catch (error) {
        console.error(`${key} を方策として読めなかった:`, error);
        return { ok: false, error: `AI「${name}」の重みを読めない（形式か、エンジンの版が違う）` };
      }
      for (const [each, held] of this.alive)
        if (held.deref() === undefined) this.alive.delete(each);
      this.alive.set(aliveKey, new WeakRef(bot));
    }
    this.loaded.delete(name);
    this.loaded.set(name, { etag: object.etag, bot });
    while (this.loaded.size > LOADED_LIMIT) {
      const oldest = this.loaded.keys().next().value;
      if (oldest === undefined) break;
      this.loaded.delete(oldest);
    }
    return { ok: true, bot };
  }
}

/**
 * AI が握れるデッキ。学習と評価に使っているデッキそのもので、表はエンジンが持つ。
 * 画面に出す名前は、看板のカード（`ace`）の名前をカードの表から引く。カード名はエンジンのデータなので、ここには持たない。
 */
export interface DeckPreset {
  label: string;
  ace: CardDefId;
}

export function deckPresets(): DeckPreset[] {
  return metaDecks.map(({ label, ace }) => ({ label, ace }));
}

export function presetDeck(label: string): DeckList | null {
  return metaDecks.find((preset) => preset.label === label)?.deck() ?? null;
}
