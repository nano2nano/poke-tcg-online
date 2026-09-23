/**
 * マッチングから決着まで、実際の HTTP と WebSocket を通して 1 局指す。
 *
 * 各層のテストが通っていても、配線が違えば人は 1 手も指せない。
 * ここだけは本物のサーバを立てて、外から見える経路だけで対戦を成立させる。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { INITIAL_RATING } from "../src/accounts.js";
import { objectKey } from "../src/archive.js";
import { engineFingerprint } from "../src/fingerprint.js";
import type { MatchRecord } from "../src/log.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import { initialCardIds, inspectState } from "../src/engine-invariants.js";
import { replay } from "../src/replay.js";
import { ensureCards, legalDecks } from "./helpers.js";
import { getCardDef, loadGeneratedCards } from "../src/engine.js";
import { sampleDeck } from "../src/sample-deck.js";
import { startWorker, type TestWorker } from "./worker.js";

let worker: TestWorker;
let base: string;

beforeAll(async () => {
  ensureCards();
  // ここで見たいのは速さの上限ではないので外しておく。上限そのものは下で見る。
  worker = await startWorker({ ACCOUNT_BURST: "0" });
  base = worker.host;
});

afterAll(async () => {
  await worker.close();
});

/** テストが開いた接続。サーバを入れ替える前に閉じる。 */
const opened = new Set<WebSocket>();

async function closeAll(): Promise<void> {
  await Promise.all(
    [...opened].map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          socket.close();
        }),
    ),
  );
  opened.clear();
}

/** 対局ログを R2 から読む。置いてある順（終わった日、識別子）に並ぶ。 */
async function storedRecords(): Promise<MatchRecord[]> {
  const { objects } = await worker.archive.list({ prefix: "matches/" });
  const records: MatchRecord[] = [];
  for (const { key } of objects) {
    const object = await worker.archive.get(key);
    records.push(JSON.parse(await object!.text()) as MatchRecord);
  }
  return records;
}

/**
 * サーバが残すのと同じ形で、記録を 1 つ植える。R2 に置き、索引にも入れる。
 * レーティングは動かさない。ここで見たいのはリプレイの側である。
 */
async function plant(record: MatchRecord): Promise<void> {
  await worker.archive.put(objectKey(record), `${JSON.stringify(record)}\n`);
  await worker.db
    .prepare(
      `INSERT INTO matches (match_id, object_key, ended_day, started_at, ended_at,
         seat0_player, seat1_player, seat0_name, seat1_name, match_result, move_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.matchId,
      objectKey(record),
      record.endedAt.slice(0, 10),
      record.startedAt,
      record.endedAt,
      record.seats[0].playerId,
      record.seats[1].playerId,
      record.seats[0].displayName,
      record.seats[1].displayName,
      JSON.stringify(record.matchResult),
      record.moves.length,
    )
    .run();
}

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
  opened.add(socket);
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

describe("公式のデッキコード", () => {
  /** 収録の欄は正規データの側にある。登録済みの定義（`getCardDef`）は持っていないことがある。 */
  function cardIdOf(defId: string): string | undefined {
    return loadGeneratedCards().find((def) => def.defId === defId)?.prints[0]?.cardID;
  }

  it("カード ID で送ったデッキが、そのまま対戦に使える形で返る", async () => {
    const counts = new Map<string, number>();
    for (const defId of sampleDeck().cards) counts.set(defId, (counts.get(defId) ?? 0) + 1);
    const cards = [...counts].map(([defId, count]) => ({
      cardId: cardIdOf(defId),
      count,
    }));

    const outcome = await postJson("/api/deck/official", { cards });

    expect(outcome.errors).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.ok).toBe(true);
    const entries = outcome.entries as { defId: string; count: number }[];
    expect(entries.flatMap(({ defId, count }) => Array<string>(count).fill(defId))).toEqual(
      sampleDeck().cards,
    );
  });

  it("エンジンに無いカードがあれば、取り込めたぶんと一緒に返し、ok にしない", async () => {
    const [defId] = sampleDeck().cards as [string];
    const cardIds = loadGeneratedCards().flatMap((def) => def.prints.map((print) => print.cardID));
    const missing = String(Math.max(...cardIds.map(Number)) + 1);

    const outcome = await postJson("/api/deck/official", {
      cards: [
        { cardId: cardIdOf(defId), count: 4 },
        { cardId: missing, count: 2 },
      ],
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.entries).toEqual([{ defId, count: 4 }]);
    expect(outcome.failures).toEqual([{ kind: "unknown-card", cardId: missing, count: 2 }]);
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

  const malformedEndpoints = [
    "/api/join",
    "/api/deck/validate",
    "/api/deck/resolve",
    "/api/deck/official",
    "/api/matches",
    "/api/replay",
    "/api/account",
    "/api/account/me",
  ];

  /**
   * 形の合わないものを素通りさせると、中身を触った先で落ちる。そこで出る例外メッセージは
   * 内側の作りの話でしかなく、読む人には意味が無い。
   *
   * **1 つずつ確かめるのではなく、POST を受けるエンドポイントを並べて全部に同じ本文を送る。**
   * この漏れは「直したエンドポイントの隣が直っていない」形で 2 度出ている。例を 1 つ足すやり方では、
   * 次に足したものがまた抜ける。
   *
   * テストはエンドポイントごとに分ける。1 つにまとめると要求の数がエンドポイントと本文の積になり、
   * どちらかを足すたびに、ほかのテストと並んで走る CI で時間の上限へ近づく。
   */
  describe("どのエンドポイントでも、形の合わない本文は同じ形で断り、内側の例外メッセージを出さない", () => {
    for (const path of malformedEndpoints) {
      it(path, async () => {
        const account = await postJson("/api/account", { displayName: "形が変な人" });
        const secret = account.secret;
        // 作れていないと、シークレットの欄が落ちた本文を送ることになり、見たい経路を通らない。
        expect(typeof secret).toBe("string");
        const [deck] = legalDecks();
        // JSON として読めるが object ではないもの、object だが欄の型が違うもの、壊れた JSON。
        const malformed: string[] = [
          "null",
          "7",
          '"ただの文字列"',
          "[1, 2, 3]",
          "{",
          JSON.stringify({ secret: null, deck }),
          JSON.stringify({ secret, deck: { cards: "デッキ" } }),
          JSON.stringify({ secret, deck: { cards: [1, 2] } }),
          JSON.stringify({ secret, deck, displayName: null }),
          JSON.stringify({ secret, deck, roomCode: 7 }),
          JSON.stringify({ secret: 7 }),
          JSON.stringify({ text: 7 }),
          JSON.stringify({ matchId: 7, ply: "さいしょ" }),
          JSON.stringify({ cards: [{ cardId: 7, count: 1 }] }),
        ];

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
      });
    }
  });

  /**
   * **欄の型が違うものは 400 で断る。** 「形が違う」と「中身が規則に反する」を混ぜると、
   * 送り手は直しようがない。`ok` と `errors` はデッキの中身の話に取っておく。
   */
  it("欄の型が違う本文は 400 で断り、形が通れば中身のエラーを返す", async () => {
    for (const [path, body] of [
      ["/api/account/me", { secret: 7 }],
      ["/api/matches", { secret: 7 }],
      ["/api/join", { secret: "あ", deck: { cards: [1] } }],
      ["/api/deck/resolve", { text: 7 }],
      ["/api/deck/official", { cards: [{ cardId: "1", count: 0 }] }],
      ["/api/deck/official", { cards: [{ cardId: "../1", count: 1 }] }],
      ["/api/account", { displayName: 7 }],
      ["/api/replay", { secret: "あ", matchId: 7 }],
    ] as [string, unknown][]) {
      const response = await fetch(`http://${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(400);
      expect(((await response.json()) as JsonBody).error, path).toBe("送られた中身の形が違う");
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
    // 自動のデプロイはこの数が 0 になるまで待つ。数え漏らすと、指している最中の対戦を消す。
    const idleCount = (await getJson("/api/status")).liveMatches as number;

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
    expect((await getJson("/api/status")).liveMatches).toBe(idleCount + 1);

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
    expect((await getJson("/api/status")).liveMatches).toBe(idleCount);
    for (const ending of endings) {
      expect(ending.t).toBe("ended");
      if (ending.t === "ended") expect(ending.matchResult.kind).toBe("normal");
    }

    // 対局ログが R2 に 1 つ置かれていて、そのまま再生できる。
    const records = await storedRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
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
    await plant(planted);
    const stale = await fetch(`http://${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: alpha.secret, matchId: planted.matchId }),
    });
    expect(stale.status).toBe(409);

    /**
     * 種の読み方が変わる前の版も読み返さない（§6.4）。こちらは弾かないと、初期盤面だけが
     * 誤りを出さずに描けてしまい、別のシャッフルを見ていることが読む人に分からない。
     */
    const old: MatchRecord = {
      ...record,
      matchId: randomUUID(),
      schemaVersion: 2,
      seed: 1234 as unknown as string,
    };
    await plant(old);
    const outdated = await fetch(`http://${base}/api/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: alpha.secret, matchId: old.matchId }),
    });
    expect(outdated.status).toBe(409);

    /**
     * **識別子の形をしていない値では読みに行かない。** 索引の問い合わせと R2 の読み出しは
     * 1 回ごとに数えられる。プレイヤーは誰でも作れるので、ここで断らないと好きな文字列で叩かれる。
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
 * プレイヤーを消すエンドポイントは無い。作れる速さに上限が無いと、D1 の行が際限なく伸びる。
 * 無料枠の書き込み回数も、その分だけ食われる。
 */
describe("プレイヤーを作れる速さ", () => {
  let limited: TestWorker;

  beforeAll(async () => {
    // 戻るまでの間はテストより十分に長い。ためてあるぶんだけが通る形で見る。
    limited = await startWorker({ ACCOUNT_BURST: "2" });
  });

  afterAll(async () => {
    await limited.close();
  });

  /**
   * 接続元は Cloudflare が付ける `cf-connecting-ip` で数える。本番では送り手が書いた同じ名前の
   * 要素は Cloudflare が上書きするが、手元の workerd は書いたまま通すので、ここでは接続元を名乗れる。
   */
  const create = async (from: string): Promise<Response> =>
    fetch(`http://${limited.host}/api/account`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": from },
      body: JSON.stringify({ displayName: "たくさん" }),
    });

  const count = async (): Promise<number> =>
    (await limited.db.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>())!.n;

  it("続けて作りすぎると 429 で断り、合図を付けて返す", async () => {
    expect((await create("203.0.113.1")).status).toBe(200);
    expect((await create("203.0.113.1")).status).toBe(200);

    const refused = await create("203.0.113.1");
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as JsonBody).code).toBe("too-many-accounts");

    // 断ったぶんは保存もされていない。
    expect(await count()).toBe(2);

    // 別の接続元は別に数える。
    expect((await create("203.0.113.2")).status).toBe(200);

    /**
     * **`x-forwarded-for` を書き換えても素通りしない。** 送り手が好きに書ける値なので、
     * 見てしまうと上限を置いた意味がそのまま消える。
     */
    const spoofed = await fetch(`http://${limited.host}/api/account`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.1",
        "x-forwarded-for": "10.0.0.9",
      },
      body: JSON.stringify({ displayName: "なりすまし" }),
    });
    expect(spoofed.status).toBe(429);

    // 上限はアカウントを作るエンドポイントだけに掛かる。ほかのエンドポイントはこれまでどおり答える。
    const others = await fetch(`http://${limited.host}/api/account/me`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
      body: JSON.stringify({ secret: "そんなシークレットは無い" }),
    });
    expect(others.status).toBe(404);
  });
});

/**
 * Durable Object は、デプロイのたびにも、Cloudflare の都合でも入れ替わる。
 * メモリにしか無いものは消えてよいが、プレイヤーと終わった対戦は残っていなければならない。
 */
describe("サーバが入れ替わったあと", () => {
  it("プレイヤーも、レーティングも、終わった対戦も残っている", async () => {
    const alpha = await postJson("/api/account", { displayName: "のこる" });
    const beta = await postJson("/api/account", { displayName: "のこす" });
    const deck = legalDecks()[0];
    const first = await postJson("/api/join", { secret: alpha.secret, deck, roomCode: "いれかえ" });
    const second = await postJson("/api/join", { secret: beta.secret, deck, roomCode: "いれかえ" });
    const claimed = await getJson(`/api/claim?ticket=${first.ticket}`);
    await new Promise<void>((resolve) => {
      let ended = 0;
      const finish = (): void => {
        ended += 1;
        if (ended === 2) resolve();
      };
      seatClient(claimed.seat.seatToken, finish);
      seatClient(second.seat.seatToken, finish);
    });
    const before = await postJson("/api/account/me", { secret: alpha.secret });
    expect(before.games).toBe(1);

    expect((await getJson(`/api/claim?ticket=${first.ticket}`)).kind).toBe("finished");

    await closeAll();
    await worker.restart();

    // メモリにしか無いものは消えている。入れ替わったことをここで確かめる。
    expect((await getJson(`/api/claim?ticket=${first.ticket}`)).kind).not.toBe("finished");

    const after = await postJson("/api/account/me", { secret: alpha.secret });
    expect(after.playerId).toBe(before.playerId);
    expect(after.rating).toBe(before.rating);
    expect(after.games).toBe(1);
    const mine = await postJson("/api/matches", { secret: alpha.secret });
    expect(mine.matches.length).toBe(1);
    const frame = await postJson("/api/replay", {
      secret: alpha.secret,
      matchId: mine.matches[0].matchId,
      ply: 0,
    });
    expect(frame.frame.ply).toBe(0);
  }, 60_000);
});
