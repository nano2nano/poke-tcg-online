import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { imageUrl } from "../lib/card-images.js";
import { useCardData } from "../lib/cards.js";
import { describeCard, nameOf } from "../lib/describe.js";
import { CardFace } from "./board.js";

/** 長押しとみなすまでの時間。 */
const LONG_PRESS_MS = 400;
/** 長押しの途中で指がこれより動いたら、スクロールのつもりとみなしてやめる。 */
const LONG_PRESS_SLOP_PX = 10;
const PREVIEW_MARGIN_PX = 8;
const PREVIEW_GAP_PX = 12;

type Pointer = "mouse" | "touch";

interface Shown {
  card: HTMLElement;
  defId: string;
  pointer: Pointer;
}

/**
 * マウスを載せている間（タッチ端末では長押しの間）、カードを大きく出す。印刷の小さな文字は
 * 盤面の大きさでは読めない。押して開く拡大と違ってマウスの操作を受けないので、手を指す邪魔をしない。
 *
 * どの画面のカードにも出すので、ルートに 1 つ置き、文書全体のポインタの動きを見る。
 */
export function CardPreview() {
  const [shown, setShown] = useState<Shown | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const { table, images } = useCardData();

  useEffect(() => {
    let current: Shown | null = null;
    let lastMouse: { x: number; y: number } | null = null;
    let longPress: { pointerId: number; x: number; y: number; timer: number } | null = null;
    // 長押しで読んで指を離すと、そのクリックも届いて拡大が開いてしまう。
    let swallowClick = false;

    const show = (card: HTMLElement, pointer: Pointer) => {
      const defId = card.dataset.defId ?? "";
      if (current?.card === card && current.defId === defId) return;
      current = { card, defId, pointer };
      setShown(current);
      watch.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-def-id"],
      });
    };
    const hide = () => {
      if (current === null) return;
      current = null;
      watch.disconnect();
      setShown(null);
    };
    // 盤面は相手の手でも描き直され、載せていたカードが消えたり別のカードに替わったりする。マウスなら下に来た
    // カードへ移り、閉じてから開き直す一瞬のちらつきを出さない。指で押している最中なら、押したカードはもう無いので閉じる。
    const watch = new MutationObserver(() => {
      if (current === null) return;
      if (current.card.isConnected) {
        show(current.card, current.pointer);
        return;
      }
      const under =
        longPress === null && lastMouse !== null
          ? document.elementFromPoint(lastMouse.x, lastMouse.y)
          : null;
      const card = previewable(under);
      if (card === null) hide();
      else show(card, "mouse");
    });
    const endLongPress = () => {
      if (longPress === null) return;
      clearTimeout(longPress.timer);
      longPress = null;
      hide();
    };

    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const card = previewable(event.target);
      if (card !== null) show(card, "mouse");
    };
    const out = (event: PointerEvent) => {
      if (event.pointerType === "touch" || current === null) return;
      if (event.relatedTarget instanceof Node && current.card.contains(event.relatedTarget)) return;
      hide();
    };
    const down = (event: PointerEvent) => {
      swallowClick = false;
      if (event.pointerType !== "touch") return;
      endLongPress();
      const card = previewable(event.target);
      if (card === null) return;
      const timer = window.setTimeout(() => {
        if (!card.isConnected) return;
        show(card, "touch");
        swallowClick = true;
      }, LONG_PRESS_MS);
      longPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "touch") lastMouse = { x: event.clientX, y: event.clientY };
      if (longPress?.pointerId !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y);
      if (moved > LONG_PRESS_SLOP_PX) endLongPress();
    };
    const up = (event: PointerEvent) => {
      if (longPress?.pointerId === event.pointerId) endLongPress();
    };
    const click = (event: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    // 長押しで出る画像の保存や選択のメニューが、プレビューの上に重なる。
    const menu = (event: Event) => {
      if (longPress !== null) event.preventDefault();
    };
    // 一覧やページが送られるとカードは動くが、マウスの下が同じカードのままなら置き直す合図が来ない。
    const scroll = (event: Event) => {
      const target = event.target;
      if (current === null || !(target instanceof Node) || !target.contains(current.card)) return;
      if (box.current !== null) place(box.current, current.card, current.pointer);
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    document.addEventListener("click", click, { capture: true });
    document.addEventListener("contextmenu", menu);
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      watch.disconnect();
      if (longPress !== null) clearTimeout(longPress.timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      document.removeEventListener("click", click, { capture: true });
      document.removeEventListener("contextmenu", menu);
      document.removeEventListener("scroll", scroll, { capture: true });
    };
  }, []);

  // 中身が替わると大きさも変わるので、描いてから置く。
  useLayoutEffect(() => {
    if (shown !== null && box.current !== null) place(box.current, shown.card, shown.pointer);
  });

  const defId = shown?.defId;
  // 画像があれば効果まで画像で読める。無いときだけ、名前の面に種類とワザを書き添える。
  const withImage = defId !== undefined && imageUrl(images, table[defId]?.cardID) !== null;
  return (
    // 同じ説明は各カードが読み上げ用に持っている。二重に読ませない。
    <div
      id="card-preview"
      className="card-preview"
      aria-hidden="true"
      hidden={shown === null}
      ref={box}
    >
      {defId !== undefined && <CardFace defId={defId} />}
      {defId !== undefined && !withImage && (
        <p>
          <strong>{nameOf(table, defId)}</strong> {describeCard(table[defId])}
        </p>
      )}
    </div>
  );
}

function previewable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const card = target.closest<HTMLElement>(".card[data-def-id]");
  // 開いた拡大の中のカードは、もう大きい。
  if (card === null || card.closest("dialog, #card-preview") !== null) return null;
  return card;
}

/**
 * カードの横に出し、入らなければ上下、それも無理なら画面の中央に重ねる。
 * 指で押しているときは、指と手のひらが下と横を隠すので上を先に試す。
 * 画面の幅は `clientWidth` で測る。`innerWidth` はスクロールバーの下まで含む。
 */
function place(preview: HTMLElement, card: HTMLElement, pointer: Pointer): void {
  const rect = card.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const width = preview.offsetWidth;
  const height = preview.offsetHeight;
  const maxX = clientWidth - width - PREVIEW_MARGIN_PX;
  const maxY = clientHeight - height - PREVIEW_MARGIN_PX;
  const clamp = (value: number, max: number) => Math.max(PREVIEW_MARGIN_PX, Math.min(value, max));
  const beside = clamp(rect.top + rect.height / 2 - height / 2, maxY);
  const across = clamp(rect.left + rect.width / 2 - width / 2, maxX);
  const right = { x: rect.right + PREVIEW_GAP_PX, y: beside };
  const left = { x: rect.left - PREVIEW_GAP_PX - width, y: beside };
  const above = { x: across, y: rect.top - PREVIEW_GAP_PX - height };
  const below = { x: across, y: rect.bottom + PREVIEW_GAP_PX };
  const order = pointer === "touch" ? [above, right, left, below] : [right, left, above, below];
  const spot = order.find(
    ({ x, y }) => x >= PREVIEW_MARGIN_PX && x <= maxX && y >= PREVIEW_MARGIN_PX && y <= maxY,
  ) ?? { x: clamp((clientWidth - width) / 2, maxX), y: clamp((clientHeight - height) / 2, maxY) };
  preview.style.left = `${spot.x}px`;
  preview.style.top = `${spot.y}px`;
}
