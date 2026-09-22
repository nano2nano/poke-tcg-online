/**
 * 呼ぶ速さの上限（`docs/spec/battle-server.md` 7.2 節）。
 *
 * **ここで守るのは、作った覚えの無いものが際限なく増えないことである。**
 * アカウントは誰でも名乗りだけで作れて、消すエンドポイントが無い。増えるのはメモリと
 * `accounts.jsonl` の行で、後者は起動のたびに同期で読む。放っておくと、
 * 増やされたぶんだけ起動が遅くなる。
 *
 * **遮断ではなく減速である。** 同じ送信元から何人も作ることは普通にある（家、学校、
 * 携帯の回線）。遅らせれば、人が使うぶんには当たらず、機械で回すぶんには当たる。
 */

/** どこから来たかの見分け。プロキシの向こうは分からないので、見えている値をそのまま使う。 */
export type Origin = string;

export interface RateLimitOptions {
  /** ためておける回数。これだけは続けて通る。 */
  burst: number;
  /** 1 回ぶんが戻るまでの時間（ミリ秒）。 */
  refillMs: number;
  /** 覚えておく送信元の数。超えたら古いものから捨てる。 */
  origins: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimit {
  private readonly buckets = new Map<Origin, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  /**
   * 1 回ぶん使う。使えたら true、いまは待ってほしいときは false。
   *
   * 時計を引数で受けるのは、試験が眠らずに済むようにするためである（コア D-3 と同じ考え方）。
   */
  take(origin: Origin, nowMs: number): boolean {
    const { burst, refillMs, origins } = this.options;
    const bucket = this.buckets.get(origin) ?? { tokens: burst, at: nowMs };
    // 経った時間のぶんだけ戻す。上限は burst で頭打ちにする。
    const restored = refillMs > 0 ? Math.floor((nowMs - bucket.at) / refillMs) : 0;
    if (restored > 0) {
      bucket.tokens = Math.min(burst, bucket.tokens + restored);
      bucket.at += restored * refillMs;
    }
    // 初めて見る送信元は、いまを起点にする。
    if (!this.buckets.has(origin)) bucket.at = nowMs;

    const allowed = bucket.tokens > 0;
    if (allowed) bucket.tokens -= 1;

    // 入れ直して、最後に触ったものを新しい側へ寄せる。
    this.buckets.delete(origin);
    this.buckets.set(origin, bucket);
    while (this.buckets.size > origins) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return allowed;
  }
}
