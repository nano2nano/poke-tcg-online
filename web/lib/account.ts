/**
 * このブラウザのプレイヤー。シークレットは localStorage に置き、サーバは控えを持たない（仕様 7.2 節）。
 * 失うと、そのレーティングと戦績とリプレイには戻れない。
 */

import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Account } from "../../src/accounts.js";
import { postJson } from "./api.js";

export type { Account };

/** いまの画面と同じキー。入れ替えのあとも同じプレイヤーで指せる。 */
const SECRET_KEY = "poke-account-secret";

export const accountKey = ["account"] as const;

export function storedSecret(): string | null {
  return localStorage.getItem(SECRET_KEY);
}

/**
 * プレイヤーを 1 人だけ用意する。画面を開いたときの読み込みと「対戦をさがす」は同じクエリの結果を待つ。
 * 重なって 2 人できると、画面に出ているレーティングと実際に指すプレイヤーが食い違う。
 *
 * `displayName` は、作るときに付ける表示名。読み直すときには使わない。
 */
export function accountQuery(displayName: () => string) {
  return queryOptions({
    queryKey: accountKey,
    queryFn: () => loadAccount(displayName()),
    staleTime: Infinity,
    // 取り直しはプレイヤーを作る要求にもなる。押し直したときに取りに行けば足りる。
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** シークレットが無ければプレイヤーを作る。あれば戦績を読み直す。 */
export async function loadAccount(displayName: string): Promise<Account> {
  const secret = storedSecret();
  if (secret !== null) {
    const response = await readAccount(secret);
    if (response.ok) return (await response.json()) as Account;
    /**
     * **消すのは、サーバが「そのアカウントはいない」と言ったときだけである。**
     * 404 という番号だけでは足りない。静的ファイルの取りこぼしも、前の版が動いているサーバも、
     * 間に挟まった中継も 404 を返す。合図が付いている応答だけを本物とする。
     */
    const failure = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (failure?.code !== "account-not-found") {
      throw new Error(
        `アカウントを読めなかった（${response.status}）。シークレットはそのまま残してある。`,
      );
    }
    localStorage.removeItem(SECRET_KEY);
  }
  const created = await postJson<{ secret?: unknown; account: Account }>("/api/account", {
    displayName,
  });
  // 置けるのは文字列だけである。`undefined` を置くと、次に開くまで直らない。
  if (typeof created.secret !== "string") throw new Error("プレイヤーを作れなかった");
  localStorage.setItem(SECRET_KEY, created.secret);
  return created.account;
}

/**
 * 決着でレーティングが動いたので読み直す。読み直すだけで、プレイヤーは作らない。
 * 席に着いているあいだはロビーを閉じているので、クエリを取り直させる代わりに値を置き換える。
 */
export async function refreshAccount(queryClient: QueryClient): Promise<void> {
  const secret = storedSecret();
  if (secret === null) return;
  const response = await readAccount(secret);
  if (response.ok) queryClient.setQueryData(accountKey, (await response.json()) as Account);
}

function readAccount(secret: string): Promise<Response> {
  return fetch("/api/account/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
}

/** レーティングと戦績の 1 行。 */
export function accountText(account: Account): string {
  const record =
    account.games === 0
      ? "まだ対戦していません"
      : `${account.games} 戦 ${account.wins} 勝 ${account.losses} 敗 ${account.draws} 分`;
  return `レーティング ${account.rating}（${record}）`;
}
