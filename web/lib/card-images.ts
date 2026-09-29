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

/** 手放された要素。同じ描き直しの中で、同じ画像のカードが拾う。 */
const spares = new Map<string, HTMLImageElement[]>();
let sweeping = false;

/** 読めなかったときに知らせる先。要素を使っている部品だけが受け取る。 */
const owners = new WeakMap<HTMLImageElement, () => void>();

export function imageUrl(enabled: boolean, cardID: string | undefined): string | null {
  if (!enabled || cardID === undefined) return null;
  const url = `/api/card-image/${cardID}`;
  return failedImages.has(url) ? null : url;
}

/** `src` の画像の要素を借りる。読めなかったら `onFailed` を呼ぶ。 */
export function takeImage(src: string, onFailed: () => void): HTMLImageElement {
  const image = spares.get(src)?.pop() ?? createImage(src);
  owners.set(image, onFailed);
  return image;
}

/**
 * 借りた要素を返す。React は描き直しで消える部品の片付けを、新しく出る部品の用意より先に済ませるので、
 * 同じ描き直しで出る同じ画像のカードが拾える。拾われなかったものは、描き直しが済んだら捨てる。
 */
export function releaseImage(image: HTMLImageElement): void {
  owners.delete(image);
  image.remove();
  const src = image.getAttribute("src");
  if (src === null || failedImages.has(src)) return;
  const same = spares.get(src);
  if (same === undefined) spares.set(src, [image]);
  else same.push(image);
  if (sweeping) return;
  sweeping = true;
  queueMicrotask(() => {
    spares.clear();
    sweeping = false;
  });
}

function createImage(src: string): HTMLImageElement {
  const image = document.createElement("img");
  // 名前は下の面が持っている。読み上げで二重にしない。
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    failedImages.add(src);
    owners.get(image)?.();
  });
  image.src = src;
  return image;
}
