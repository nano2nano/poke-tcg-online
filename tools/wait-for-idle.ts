/**
 * 本番で指している対戦が無くなるまで待つ。自動のデプロイ（`.github/workflows/verify.yml`）が、
 * `wrangler deploy` の前に呼ぶ。
 *
 * デプロイすると Durable Object が入れ替わり、指している最中の対戦は消える（仕様 10 節）。
 *
 * 使い方: `npx tsx tools/wait-for-idle.ts <本番の URL> [待つ上限の分]`
 *
 * 本番を Cloudflare Access の内側に置いたときは、サービストークンを環境変数
 * `CF_ACCESS_CLIENT_ID` と `CF_ACCESS_CLIENT_SECRET` で渡す（`docs/deploy.md`）。
 * 渡さないと Access に止められ、数を読めないまま上限まで待って失敗する。
 */

import { setTimeout as sleep } from "node:timers/promises";

const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

const [base, limitArg] = process.argv.slice(2);
if (base === undefined) {
  process.stderr.write("使い方: npx tsx tools/wait-for-idle.ts <本番の URL> [待つ上限の分]\n");
  process.exit(2);
}
const limitMinutes = Number(limitArg || "60");
if (!Number.isFinite(limitMinutes) || limitMinutes < 0) {
  process.stderr.write(`待つ上限の分として読めない: ${limitArg}\n`);
  process.exit(2);
}
const statusUrl = new URL("/api/status", base);
const accessHeaders: Record<string, string> =
  process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? {
        "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID,
        "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET,
      }
    : {};
const deadline = Date.now() + limitMinutes * 60_000;

type Reading =
  | { kind: "count"; liveMatches: number }
  | { kind: "absent" }
  | { kind: "unreadable"; reason: string };

async function read(): Promise<Reading> {
  let response: Response;
  try {
    response = await fetch(statusUrl, {
      headers: accessHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: "unreadable", reason: String(error) };
  }
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // 下で形の違う応答として扱う。
  }
  /**
   * このサーバ自身の 404 だけを「動いている版はこのエンドポイントを持たない」と読む。持たない版から
   * 上げるときに起きる。URL の誤りや Cloudflare 側の 404 まで同じに読むと、以後ずっと待たずに出す。
   */
  if (response.status === 404 && (body as { error?: unknown } | null)?.error === "not found") {
    return { kind: "absent" };
  }
  const liveMatches = (body as { liveMatches?: unknown } | null)?.liveMatches;
  if (!response.ok || typeof liveMatches !== "number" || !Number.isInteger(liveMatches)) {
    return { kind: "unreadable", reason: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  return { kind: "count", liveMatches };
}

/**
 * 数が読めないときも待ち続け、上限で失敗する。読めないのは本番の調子が悪いときで、対戦が
 * 残っているかもしれない。本番が落ちていて直しを急ぐなら、待たずに出す手動実行がある。
 */
for (;;) {
  const reading = await read();
  if (reading.kind === "count" && reading.liveMatches === 0) {
    process.stdout.write("指している対戦は無い\n");
    process.exit(0);
  }
  if (reading.kind === "absent") {
    process.stdout.write(
      `::warning::${statusUrl} を持たない版が動いている。対戦の数が分からないので、待たずに出す\n`,
    );
    process.exit(0);
  }
  process.stdout.write(
    reading.kind === "count"
      ? `指している対戦が ${reading.liveMatches} 局ある。終わるのを待つ\n`
      : `対戦の数を読めない: ${reading.reason}\n`,
  );
  if (Date.now() + POLL_MS > deadline) {
    process.stdout.write(
      `::error::${limitMinutes} 分待っても、対戦が無いことを確かめられなかった。出していない。` +
        "待たずに出すなら、Actions から verify を main に対して手動実行し、wait_for_idle を外す\n",
    );
    process.exit(1);
  }
  await sleep(POLL_MS);
}
