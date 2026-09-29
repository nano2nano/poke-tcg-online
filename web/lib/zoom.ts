/**
 * 押すと大きく出すカード。盤面のカードは印刷の文字が読めない大きさなので、押して読む。
 * 開くのはルートに 1 つ置いた `CardZoom` で、ここは開いてもらう側の取り決めだけを持つ。
 */

import { createContext, useContext, type KeyboardEvent } from "react";

/** 出す見出しとカード。場のポケモンなら、進化の下のカードとついているカードもまとめて出す。 */
export interface ZoomTarget {
  title: string;
  defIds: readonly string[];
}

export const ZoomContext = createContext<(target: ZoomTarget) => void>(() => {});

/** 押すかキーで選ぶと `target` を大きく出す要素の属性。 */
export function useZoomable(target: ZoomTarget | undefined) {
  const open = useContext(ZoomContext);
  if (target === undefined) return {};
  return {
    tabIndex: 0,
    role: "button",
    onClick: () => open(target),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      // スペースで画面が送られないようにする。
      event.preventDefault();
      open(target);
    },
  };
}
