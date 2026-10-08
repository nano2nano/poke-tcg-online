/**
 * 押すと大きく出すカード。盤面のカードは印刷の文字が読めない大きさなので、押して読む。
 * 開くのはルートに 1 つ置いた `CardZoom` で、ここは開いてもらう側の取り決めだけを持つ。
 */

import { createContext, useContext, type KeyboardEvent } from "react";
import type { MenuSubject } from "./card-menu.js";
import type { MoveKind } from "./move-groups.js";

/** 出す見出しとカード。場のポケモンなら、進化の下のカードとついているカードもまとめて出す。 */
export interface ZoomTarget {
  title: string;
  defIds: readonly string[];
  /** 盤面の何を大きく出したか。座席の画面は、それでできる手を添える。 */
  subject?: MenuSubject;
}

export const ZoomContext = createContext<(target: ZoomTarget) => void>(() => {});

/** 大きく出したものでできる手を、種類ごとに分けたもの。 */
export interface ZoomMoves {
  list: (subject: MenuSubject) => readonly {
    kind: MoveKind;
    title: string;
    entries: readonly { key: string; label: string; play: () => void }[];
  }[];
}

/** 座席の画面が、大きく出したものでできる手を渡す。座席を離れたら null を渡す。 */
export const ZoomMovesContext = createContext<(moves: ZoomMoves | null) => void>(() => {});

/**
 * 押すかキーで選ぶと `target` を大きく出す要素の属性。`instead` を渡すと、大きく出す代わりにそれを呼ぶ
 * （効果で選べるポケモンを押して選ぶときなど）。
 */
export function useZoomable(target: ZoomTarget | undefined, instead?: () => void) {
  const zoom = useContext(ZoomContext);
  if (target === undefined) return {};
  const open = instead ?? (() => zoom(target));
  return {
    tabIndex: 0,
    role: "button",
    onClick: open,
    // ボタンと同じく、Enter は押したとき、スペースは離したときに開く。開くと「閉じる」に移るので、
    // 同じキーの続き（Enter の keypress、スペースの keyup）が「閉じる」を押さないようにする。
    onKeyDown: (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      // Enter の keypress を出させない。スペースでは画面が送られないようにする。
      event.preventDefault();
      // 「閉じる」で Enter を押し続けると、閉じて戻ったこの要素にくり返しが届く。開き直さない。
      if (event.key === "Enter" && !event.repeat) open();
    },
    onKeyUp: (event: KeyboardEvent) => {
      if (event.target === event.currentTarget && event.key === " ") open();
    },
  };
}
