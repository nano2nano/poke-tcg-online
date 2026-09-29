/**
 * カードの画像の要素。描き直しで同じ画像のカードがほかの場所へ移っても、前に出していた要素を移して使う。
 *
 * 作り直すと、画像をキャッシュから出せない環境では読み込み直すまで名前の面が見え、手を打つたびに
 * カードが一瞬名前の面に戻る。Safari で起き、Chromium でもキャッシュを切ると同じになる。
 * React は親の違う要素を移さないので、画像の要素だけは部品の外で持つ。
 */

/**
 * 読めなかった画像。盤面は 1 手ごとに描き直すので、覚えておかないと公式が落ちているあいだ
 * 1 手ごとに全部のカードを頼み直す。開き直せば、もう一度頼む。
 */
const failedImages = new Set<string>();

/** 手放された要素。同じコミットの中で、同じ画像のカードが拾う。 */
const spares = new Map<string, HTMLImageElement[]>();
let sweeping = false;

/** 貸している要素と、読めなかったときに知らせる先。画像ごとに持つ。 */
const lent = new Map<string, Map<HTMLImageElement, () => void>>();

/**
 * 読んでいる最中の画像と、読み終わるのを待っている要素。読んでいる最中に同じ画像のカードが出ても、
 * `src` を付けずに待たせる。Chromium でも版によっては、読んでいる最中の同じ URL を分け合わずに
 * もう一度頼む。読めたら待っている要素に `src` を付け、読めなければ付けずに捨てる。
 */
const pending = new Map<string, Set<HTMLImageElement>>();
const loaded = new Set<string>();
/** 要素ごとの画像。待っている要素は `src` 属性をまだ持たない。 */
const sources = new WeakMap<HTMLImageElement, string>();

export function imageUrl(enabled: boolean, cardID: string | undefined): string | null {
  if (!enabled || cardID === undefined) return null;
  const url = `/api/card-image/${cardID}`;
  return failedImages.has(url) ? null : url;
}

/** `src` の画像の要素を借りる。読めなかったら `onFailed` を呼ぶ。 */
export function takeImage(src: string, onFailed: () => void): HTMLImageElement {
  const image = spares.get(src)?.pop() ?? createImage(src);
  const same = lent.get(src);
  if (same === undefined) lent.set(src, new Map([[image, onFailed]]));
  else same.set(image, onFailed);
  return image;
}

/**
 * 借りた要素を返す。React は 1 回のコミットの中で、消える部品の `useLayoutEffect` のクリーンアップを
 * 新しく出る部品の `useLayoutEffect` より先に実行するので、同じコミットで出る同じ画像のカードが拾える。
 * 拾われなかったものは、コミットが済んだら捨てる。
 */
export function releaseImage(image: HTMLImageElement): void {
  image.remove();
  const src = sources.get(image);
  if (src === undefined) return;
  const same = lent.get(src);
  same?.delete(image);
  if (same?.size === 0) lent.delete(src);
  if (failedImages.has(src)) return;
  const pooled = spares.get(src);
  if (pooled === undefined) spares.set(src, [image]);
  else pooled.push(image);
  if (sweeping) return;
  sweeping = true;
  queueMicrotask(() => {
    // 捨てる要素は、読み終わっても `src` を付けない。付けると、どこにも出さない画像を頼む。
    for (const [dropped, images] of spares) {
      for (const each of images) pending.get(dropped)?.delete(each);
    }
    spares.clear();
    sweeping = false;
  });
}

function createImage(src: string): HTMLImageElement {
  const image = document.createElement("img");
  sources.set(image, src);
  // 名前は下の面が持っている。読み上げで二重にしない。
  image.alt = "";
  image.decoding = "async";
  image.addEventListener("error", () => {
    // 同じ画像の要素はそれぞれ失敗を知らせてくる。貸している先へ知らせるのは最初の 1 回だけにする。
    if (failedImages.has(src)) return;
    failedImages.add(src);
    pending.delete(src);
    for (const onFailed of lent.get(src)?.values() ?? []) onFailed();
  });
  const waiting = pending.get(src);
  if (waiting !== undefined) {
    image.loading = "lazy";
    waiting.add(image);
    return image;
  }
  if (loaded.has(src)) {
    image.loading = "lazy";
  } else {
    // 同じ画像のほかの要素はこの要素が読み終わるのを待つので、これは見えなくてもすぐ読む。
    pending.set(src, new Set());
    image.addEventListener("load", () => {
      loaded.add(src);
      for (const each of pending.get(src) ?? []) each.src = src;
      pending.delete(src);
    });
  }
  image.src = src;
  return image;
}
