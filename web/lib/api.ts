export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} が ${response.status} を返した`);
  return (await response.json()) as T;
}

/**
 * 応答の可否を見る。見ないと、エラーの本文をそのまま中身として読み、`undefined` を触った先で分かりにくいエラーになる。
 *
 * ただし **`ok: false` は投げない。** 「デッキのここが規則に通らない」のような、呼び手が人に見せるための応答である。
 * 投げると理由が落ちて、「400 が返った」しか出せなくなる。
 */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await post(path, body);
  const answer = (await response.json().catch(() => null)) as
    | (T & { ok?: unknown; error?: unknown; code?: unknown })
    | null;
  if (answer !== null && (response.ok || answer.ok === false)) return answer;
  throw new ApiError(
    typeof answer?.error === "string" ? answer.error : `${path} が ${response.status} を返した`,
    answer?.code,
  );
}

/** サーバが断った理由。`code` があれば、呼び手はそれで分ける。 */
export class ApiError extends Error {
  readonly code: unknown;

  constructor(message: string, code: unknown) {
    super(message);
    this.code = code;
  }
}

/** 応答をそのまま返す。状態の番号だけでなく本文も見て決めたいときに使う。 */
export function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
