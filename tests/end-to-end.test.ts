/**
 * マッチングから決着まで、実際の HTTP と WebSocket を通して 1 局指す。
 *
 * 各層のテストが通っていても、配線が違えば人は 1 手も指せない。
 * ここだけは本物のサーバを立てて、外から見える経路だけで対戦を成立させる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type App } from "../src/app.js";
import { INITIAL_RATING } from "../src/accounts.js";
import { engineFingerprint } from "../src/fingerprint.js";
import type { MatchRecord } from "../src/log.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { replay } from "../src/replay.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { getCardDef, loadGeneratedCards } from "../src/engine.js";
import { sampleDeck } from "../src/sample-deck.js";

let app: App;
let base: string;
let logDir: string;

beforeAll(async () => {
  ensureCards();
  logDir = mkdtempSync(join(tmpdir(), "poke-online-e2e-"));
  // ここで見たいのは速さの上限ではないので、当たらない値にしておく。上限そのものは下で見る。
  app = createApp({
    logDir,
    accountDir: logDir,
    accountLimit: { burst: 1_000, refillMs: 1, origins: 16 },
  });
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", () => resolve()));
  const { port } = app.http.address() as AddressInfo;
  base = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

/** 応答の形はテストの中でだけ広げて読む。サーバ側の型は `protocol.ts` が持つ。 */
type JsonBody = Record<string, any>;

async function postJson(path: string, body: unknown): Promise<JsonBody> {
  const response = await fetch(`http://${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as JsonBody;
}

async function getJson(path: string): Promise<JsonBody> {
  return (await (await fetch(`http://${base}${path}`)).json()) as JsonBody;
}

/**
 * 座席 1 つぶんのクライアント。届いた合法手から 1 つ選んで送り返すだけで、
 * 盤面の判断を一切持たない。**サーバが手番でない座席へ合法手を送らないので、
 * 2 つの座席が同時に指そうとすることは起きない。**
 */
function seatClient(seatToken: string, ended: (message: ServerMessage) => void): WebSocket {
  const socket = new WebSocket(`ws://${base}/ws?seatToken=${seatToken}`);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.t === "ended") {
      ended(message);
      return;
    }
    if (message.t !== "sync" && message.t !== "delta") return;
    const legal = message.legalMoves;
    if (legal === null || legal.length === 0) return;
    const move: ClientMessage = {
      t: "move",
      stateVersion: message.stateVersion,
      move: legal[0]!,
    };
    socket.send(JSON.stringify(move));
  });
  return socket;
}

/**
 * サンプルデッキを、人が書くのと同じ文字列へ起こす。**カードの名前をテストへ書き写さない**ため、
 * 名前は登録済みの定義から引く。同じ名前が複数あるときは `defId` を書き添える形にする。
 */
function sampleDecklistText(): string {
  const counts = new Map<string, number>();
  for (const defId of sampleDeck().cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);

  const shared = new Set<string>();
  const seen = new Set<string>();
  for (const def of loadGeneratedCards()) {
    if (seen.has(def.name)) shared.add(def.name);
    seen.add(def.name);
  }

  const lines: string[] = [];
  for (const [defId, count] of counts) {
    const { name } = getCardDef(defId);
    lines.push(shared.has(name) ? `${name} ${count} ${defId}` : `${name} ${count}`);
  }
  return lines.join("\n");
}

describe("人が書いたデッキ", () => {
  it("文字列で出したデッキが、そのまま対戦に使える形で返る", async () => {
    const outcome = await postJson("/api/deck/resolve", { text: sampleDecklistText() });

    expect(outcome.errors).toEqual([]);
    expect(outcome.ok).toBe(true);
    // 順序まで含めて情報源なので、枚数だけでなく列そのものを見る。
    expect(outcome.deck.cards).toEqual(sampleDeck().cards);
  });

  it("同じ名前が複数あるカードは、候補を返して拒否する", async () => {
    const shared = new Map<string, number>();
    for (const def of loadGeneratedCards()) {
      shared.set(def.name, (shared.get(def.name) ?? 0) + 1);
    }
    const ambiguous = [...shared.entries()]
      .filter(([, count]) => count > 1)
      .sort(([a], [b]) => (a < b ? -1 : 1))[0];
    if (ambiguous === undefined) throw new Error("重複する名前が無い");

    const outcome = await postJson("/api/deck/resolve", { text: `${ambiguous[0]} 4` });

    expect(outcome.ok).toBe(false);
    expect(outcome.failures[0].kind).toBe("ambiguous");
    expect(outcome.failures[0].choices.length).toBe(ambiguous[1]);
  });

  it("デッキの文字列が無い要求を 400 で返す", async () => {
    const response = await fetch(`http://${base}/api/deck/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });
});

/**
 * エラーの理由は画面まで届かなければ意味がない。`/api/join` のエラー応答は `error` の 1 行ではなく
 * `errors` の並びで返るので、画面はこの形を読む。ここが変わると理由が黙って落ちる。
 */
describe("入れなかった理由", () => {
  it("エラー応答は 400 と `ok: false` と理由の並びで返る", async () => {
    const response = await fetch(`http://${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "そんなシークレットは無い", deck: legalDecks()[0] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(false);
    expect(body.errors).toEqual(["アカウントが見つからない"]);
    // 1 行の `error` は持たない。画面がそちらだけを見ると理由が落ちる。
    expect(body.error).toBeUndefined();
  });

  /**
   * **アカウントが無いことは、デッキの違反と同じ形で返してはいけない。** 画面は文言でしか
   * 見分けられなくなり、覚えているアカウントを読み直しに行けない。`/api/account` と同じ合図を付ける。
   */
  it("アカウントが無いときは、デッキの違反と見分けられる合図が付く", async () => {
    const gone = await fetch(`http://${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "そんなシークレットは無い", deck: legalDecks()[0] }),
    });
    expect(((await gone.json()) as JsonBody).code).toBe("account-not-found");

    const account = await postJson("/api/account", { displayName: "デッキが変な人" });
    const bad = await fetch(`http://${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: account.secret, deck: { cards: [] } }),
    });
    expect(((await bad.json()) as JsonBody).code).toBeUndefined();
  });

  it("デッキが通らないときも、通らない箇所が並びで返る", async () => {
    const account = await postJson("/api/account", { displayName: "デッキが変な人" });
    const response = await fetch(`http://${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: account.secret, deck: { cards: [] } }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(false);
    expect((body.errors as string[]).length).toBeGreaterThan(0);
  });

  /**
   * 形の合わないものを素通りさせると、中身を触った先で落ちる。そこで出る例外メッセージは
   * 内側の作りの話でしかなく、読む人には意味が無い。
   *
   * **1 つずつ確かめるのではなく、POST を受けるエンドポイントを並べて全部に同じ本文を送る。**
   * この漏れは「直したエンドポイントの隣が直っていない」形で 2 度出ている。例を 1 つ足すやり方では、
   * 次に足したものがまた抜ける。
   */
  it("どのエンドポイントでも、形の合わない本文は同じ形で断り、内側の例外メッセージを出さない", async () => {
    const account = await postJson("/api/account", { displayName: "形が変な人" });
    const endpoints = [
      "/api/join",
      "/api/deck/validate",
      "/api/decklist/resolve",
      "/api/matches",
      "/api/replay",
      "/api/account",
      "/api/account/me",
    ];
    // JSON として読めるが object ではないもの、object だが欄の型が違うもの、壊れた JSON。
    const malformed: string[] = [
      "null",
      "7",
      '"ただの文字列"',
      "[1, 2, 3]",
      "{",
      JSON.stringify({ secret: null, deck: legalDecks()[0] }),
      JSON.stringify({ secret: account.secret, deck: { cards: "デッキ" } }),
      JSON.stringify({ secret: account.secret, deck: { cards: [1, 2] } }),
      JSON.stringify({ secret: account.secret, deck: legalDecks()[0], displayName: null }),
      JSON.stringify({ secret: account.secret, deck: legalDecks()[0], roomCode: 7 }),
      JSON.stringify({ secret: 7 }),
      JSON.stringify({ text: 7 }),
      JSON.stringify({ matchId: 7, ply: "さいしょ" }),
    ];

    for (const path of endpoints) {
      for (const body of malformed) {
        const response = await fetch(`http://${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        // 形が合っていれば普通に答えてよい。落ちて 500 になっていないことがここの眼目である。
        expect(response.status, `${path} ← ${body}`).toBeLessThan(500);
        const answer = (await response.json()) as JsonBody;
        const said = JSON.stringify(answer);
        expect(said, `${path} ← ${body}`).not.toMatch(
          /is not a function|Cannot read|TypeError|JSON at position|Unexpected token/,
        );
      }
    }

    // 形が通れば、エラーの中身はこれまでどおりである。
    const fine = await fetch(`http://${base}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "そんなシークレットは無い", deck: legalDecks()[0] }),
    });
    expect(((await fine.json()) as JsonBody).errors).toEqual(["アカウントが見つからない"]);
  });

  /**
   * プレイヤーが消えたときだけシークレットを捨てられるように、番号ではなく合図を返す。
   * 静的ファイルの取りこぼしも 404 を返すので、番号だけでは見分けられない。
   */
  it("知らないシークレットの 404 と、無い道の 404 を見分けられる", async () => {
    const gone = await fetch(`http://${base}/api/account/me`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "そんなシークレットは無い" }),
    });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as JsonBody).code).toBe("account-not-found");

    const nowhere = await fetch(`http://${base}/api/account/me/nowhere`, { method: "POST" });
    expect(nowhere.status).toBe(404);
    expect(((await nowhere.json()) as JsonBody).code).toBeUndefined();
  });
});

describe("マッチングから決着まで", () => {
  it("2 人が繋がり、1 局を最後まで指し、ログが再生できる", async () => {
    const deck = legalDecks()[0];
    const alpha = await postJson("/api/account", { displayName: "あ" });
    const beta = await postJson("/api/account", { displayName: "い" });
    expect(alpha.account.rating).toBe(INITIAL_RATING);

    const first = await postJson("/api/join", {
      secret: alpha.secret,
      deck,
      roomCode: "とおし",
    });
    expect(first.ok).toBe(true);
    const second = await postJson("/api/join", {
      secret: beta.secret,
      deck,
      roomCode: "とおし",
    });
    expect(second.seat.seat).toBe(1);

    const claimed = await getJson(`/api/claim?ticket=${first.ticket}`);
    expect(claimed.seat.seat).toBe(0);

    const endings: ServerMessage[] = [];
    const done = new Promise<void>((resolve) => {
      const finish = (message: ServerMessage): void => {
        endings.push(message);
        if (endings.length === 2) resolve();
      };
      seatClient(claimed.seat.seatToken, finish);
      seatClient(second.seat.seatToken, finish);
    });

    await done;
    for (const ending of endings) {
      expect(ending.t).toBe("ended");
      if (ending.t === "ended") expect(ending.matchResult.kind).toBe("normal");
    }

    // ログが 1 行落ちていて、そのまま再生できる。
    const files = readdirSync(logDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(logDir, files[0]!), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as MatchRecord;
    let initialCards: string[] = [];
    const result = replay(record, {
      fingerprint: engineFingerprint(),
      inspect: (state, index) => {
        if (index === 0) initialCards = initialCardIds(state);
        inspectState(state, initialCards);
      },
    });
    expect(result.failures).toEqual([]);
    expect(result.applied).toBe(record.moves.length);
    expect(record.moves.length).toBeGreaterThan(10);

    // プレイヤーとその強さが対戦ごとに残る。あとから結び直すことはできない（7.2 節）。
    expect(record.seats.map((seat) => seat.playerId)).toEqual([
      alpha.account.playerId,
      beta.account.playerId,
    ]);
    expect(record.seats.map((seat) => seat.rating)).toEqual([INITIAL_RATING, INITIAL_RATING]);

    // 決着がレーティングへ入っている。記録に残るのは対戦を始めた時点の値なので、こちらだけが動く。
    const after = await postJson("/api/account/me", { secret: alpha.secret });
    expect(after.games).toBe(1);
    expect(after.rating).not.toBe(INITIAL_RATING);

    // 指した本人は、その対戦を読み返せる（6.6 節）。
    const mine = await postJson("/api/matches", { secret: alpha.secret });
    expect(mine.matches.length).toBe(1);
    expect(mine.matches[0].matchId).toBe(record.matchId);
    expect(mine.matches[0].opponentName).toBe("い");

    const start = await postJson("/api/replay", {
      secret: alpha.secret,
      matchId: record.matchId,
      ply: 0,
    });
    expect(start.frame.ply).toBe(0);
    expect(start.frame.moveCount).toBe(record.moves.length);
    expect(start.frame.views.length).toBe(2);

    // 指していない人には、その対戦は無いものとして返す。
    const stranger = await postJson("/api/account", { displayName: "よそのひと" });
    expect((await postJson("/api/matches", { secret: stranger.secret })).matches).toEqual([]);
    const denied = await fetch(`http://${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: stranger.secret, matchId: record.matchId }),
    });
    expect(denied.status).toBe(404);

    /**
     * カードの定義が変わった記録は読み返さない（§6.3）。そのまま再生すると、誤りを出さずに
     * 違う盤面を見せる。別のカードデータで指したことにした 1 行を植えて、エンドポイントが弾くのを見る。
     */
    const planted: MatchRecord = {
      ...record,
      // エンドポイントは識別子の形を確かめてから走査に入るので、ここも本物と同じ形にする。
      matchId: randomUUID(),
      engine: { ...record.engine, cardDataSha256: "ちがうカードデータ" },
    };
    appendFileSync(
      join(logDir, `${record.endedAt.slice(0, 10)}.jsonl`),
      `${JSON.stringify(planted)}\n`,
    );
    const stale = await fetch(`http://${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: alpha.secret, matchId: planted.matchId }),
    });
    expect(stale.status).toBe(409);

    /**
     * **名指しになっていない識別子で走査を始めさせない。** 空文字はどの行にも含まれるので、
     * 通すと 1 回の問い合わせで全部の日を解析することになる。プレイヤーは誰でも作れるので、
     * これを繰り返されると進行中の対戦の手も持ち時間のスイープも止まる。
     */
    for (const bad of ["", "   ", "べつのかたち", "../../etc/passwd", "%"]) {
      const refused = await fetch(`http://${base}/api/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: alpha.secret, matchId: bad }),
      });
      expect(refused.status).toBe(404);
    }
    // 形が通れば、これまでどおり引ける。
    const fine = await postJson("/api/replay", {
      secret: alpha.secret,
      matchId: record.matchId,
      ply: 0,
    });
    expect(fine.frame.ply).toBe(0);
  }, 60_000);
});

/**
 * プレイヤーを消すエンドポイントは無い。作れる速さに上限が無いと、メモリと `accounts.jsonl` の行が
 * 際限なく伸びる。後者は起動のたびに同期で読むので、増やされたぶんだけ起動が遅くなる。
 */
describe("プレイヤーを作れる速さ", () => {
  it("続けて作りすぎると 429 で断り、合図を付けて返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poke-limit-"));
    // 戻る速さを 0 にして、ためてあるぶんだけが通る形にする。テストで時間を待たない。
    const limited = createApp({
      logDir: dir,
      accountDir: dir,
      accountLimit: { burst: 2, refillMs: 0, origins: 16 },
      // 環境変数に引きずられないよう、ここで固定する。既定を見たいテストではない。
      trustedProxies: 0,
    });
    const port = await new Promise<number>((resolve) => {
      limited.http.listen(0, "127.0.0.1", () => {
        resolve((limited.http.address() as AddressInfo).port);
      });
    });
    const here = `127.0.0.1:${port}`;
    const create = async (): Promise<Response> =>
      fetch(`http://${here}/api/account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "たくさん" }),
      });

    try {
      expect((await create()).status).toBe(200);
      expect((await create()).status).toBe(200);

      const refused = await create();
      expect(refused.status).toBe(429);
      const answer = (await refused.json()) as JsonBody;
      expect(answer.code).toBe("too-many-accounts");

      // 断ったぶんは保存もされていない。
      expect(limited.accounts.count()).toBe(2);

      /**
       * **`x-forwarded-for` を書き換えても素通りしない。** 既定でその要素を見てしまうと、
       * 上限を置いた意味がそのまま消える。送り手が好きに書ける値だからである。
       */
      const spoofed = await fetch(`http://${here}/api/account`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.9" },
        body: JSON.stringify({ displayName: "なりすまし" }),
      });
      expect(spoofed.status).toBe(429);
      expect(limited.accounts.count()).toBe(2);

      // 上限はアカウントを作るエンドポイントだけに掛かる。ほかのエンドポイントはこれまでどおり答える。
      const others = await fetch(`http://${here}/api/account/me`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: "そんなシークレットは無い" }),
      });
      expect(others.status).toBe(404);
    } finally {
      await limited.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * プロキシが 2 つ（CDN とその内側など）あるとき、右端はプロキシ自身のアドレスである。
   * そこで数えると**全員が同じ 1 つとして数えられ、全体が作れなくなる。**
   * 信用するプロキシの数を指して、その手前を見る。
   */
  it("プロキシの数を指せば、プロキシの向こうの人ごとに数える", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poke-proxy-"));
    const proxied = createApp({
      logDir: dir,
      accountDir: dir,
      accountLimit: { burst: 1, refillMs: 0, origins: 16 },
      trustedProxies: 2,
    });
    const port = await new Promise<number>((resolve) => {
      proxied.http.listen(0, "127.0.0.1", () => {
        resolve((proxied.http.address() as AddressInfo).port);
      });
    });
    const create = async (chain: string): Promise<number> =>
      (
        await fetch(`http://127.0.0.1:${port}/api/account`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": chain },
          body: JSON.stringify({ displayName: "プロキシの向こう" }),
        })
      ).status;

    try {
      /**
       * プロキシは自分が受け取った相手のアドレスを足す。接続元 → 外のプロキシ → 内のプロキシ → ここ、なら
       * 外のプロキシが「接続元」を、内のプロキシが「外のプロキシ」を足して、要素は 2 つになる。
       * 接続元はいちばん左、つまり右から数えて 2 つ目である。
       */
      expect(await create("203.0.113.1, 198.51.100.7")).toBe(200);
      // 別の人は、同じプロキシを通っていても別に数える。
      expect(await create("203.0.113.2, 198.51.100.7")).toBe(200);
      // 同じ人の 2 回目は断る。
      expect(await create("203.0.113.1, 198.51.100.7")).toBe(429);

      // 信用する数より要素が少ないときは、プロキシの向こうが分からないので接続元で数える。
      expect(await create("203.0.113.3")).toBe(200);
      expect(await create("203.0.113.4")).toBe(429);

      // 送り手が要素を足しても、右から数えるので信用できるプロキシが書いた値に当たる。
      expect(await create("9.9.9.9, 203.0.113.5, 198.51.100.7")).toBe(200);
      expect(await create("8.8.8.8, 203.0.113.5, 198.51.100.7")).toBe(429);
    } finally {
      await proxied.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
