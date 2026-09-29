/**
 * 手札のカードをつかんで盤面へ落とし、手を指す。dnd-kit を使うのはこのファイルだけにする。
 * dnd-kit の React 版はまだ 0.x なので、差し替えるときに直す場所をここに閉じておく。
 *
 * つかめるのは指せる手に出てくるカードだけで、落とせる先はその手が向かう先だけである。
 * どちらも座席の画面が渡す表（`DropPlan`）で決まり、ここでは盤面の判断をしない。
 */

import { pointerIntersection } from "@dnd-kit/collision";
import { Accessibility, PointerActivationConstraints } from "@dnd-kit/dom";
import {
  DragDropProvider,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  type DragDropEventHandlers,
} from "@dnd-kit/react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { DropPlan, DropSpot } from "../lib/card-drops.js";

/** 盤面へ落として指す手。 */
export interface CardDrops {
  plan: DropPlan;
  /** 落とした先で指せる手（ボタンの `key`）を受け取る。落とせない先で離したときは呼ばない。 */
  onDrop: (keys: readonly string[]) => void;
}

interface Held {
  defId: string;
  /** つかんだカードの幅。ポインタに付いて動かすカードを同じ大きさで描く。 */
  width: number;
}

interface CardDragState {
  plan: DropPlan;
  held: Held | null;
}

const CardDrag = createContext<CardDragState | null>(null);

/** つかんで落とせる盤面の中か。外では dnd-kit のフックを呼ばない。 */
export function useInDragArea(): boolean {
  return use(CardDrag) !== null;
}

/**
 * つかみ始めるのは、マウスかペンで少し動かしてから。押したまま待っただけではつかまず、離せばカードを大きく出す。
 * タッチでは、長押しのプレビューとページのスクロールが同じ操作を取り合うので、つかませない。
 */
const SENSORS = [
  PointerSensor.configure({
    activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
    preventActivation: (event, source) =>
      event.pointerType === "touch" ||
      PointerSensor.defaults.preventActivation?.(event, source) === true,
  }),
];

type PluginList = Extract<
  NonNullable<ComponentProps<typeof DragDropProvider>["plugins"]>,
  readonly unknown[]
>;

/**
 * 読み上げの案内は外す。手札のカードは押すと大きく出すボタンで、案内を付けると、つかめないカードが
 * 押せないボタンとして読まれる。キーボードではつかませず、指せる手のボタンから選ぶ。
 */
const PLUGINS = (defaults: PluginList) => defaults.filter((plugin) => plugin !== Accessibility);

type Handlers = Partial<DragDropEventHandlers>;

/** 盤面 1 つぶんの、つかんで落とす範囲。同じ画面に盤面が 2 つあっても、カードは自分の盤面にしか落ちない。 */
export function CardDragArea({
  drops,
  overlay,
  children,
}: {
  drops: CardDrops;
  /** つかんでいるあいだ、ポインタに付いて動かすカードの面。 */
  overlay: (defId: string) => ReactNode;
  children: ReactNode;
}) {
  const { plan } = drops;
  const [held, setHeld] = useState<Held | null>(null);
  const state = useMemo(() => ({ plan, held }), [plan, held]);
  // つかんでいるあいだは、カードのプレビューを出さない。落とす先を隠す。
  useEffect(() => {
    if (held === null) return;
    document.documentElement.setAttribute("data-dragging", "");
    return () => document.documentElement.removeAttribute("data-dragging");
  }, [held]);

  const onDragStart: Handlers["onDragStart"] = (event) => {
    const { source } = event.operation;
    const defId = defIdOf(source?.data);
    const width = source?.element?.getBoundingClientRect().width ?? 0;
    setHeld(defId === null ? null : { defId, width });
  };
  const onDragEnd: Handlers["onDragEnd"] = (event) => {
    const defId = defIdOf(event.operation.source?.data);
    setHeld(null);
    const spot = event.operation.target?.id;
    if (event.canceled || defId === null || typeof spot !== "string") return;
    const keys = plan.get(defId)?.get(spot);
    if (keys !== undefined && keys.length > 0) drops.onDrop(keys);
  };

  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <CardDrag value={state}>{children}</CardDrag>
      {/* 落とした手は、局面が届いてから盤面のカードが手札から動いて見せる。ここでは戻して見せない。 */}
      <DragOverlay dropAnimation={null} style={{ "--w": `${held?.width ?? 0}px` } as CSSProperties}>
        {(source) => {
          const defId = defIdOf(source.data);
          return defId === null ? null : overlay(defId);
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

function defIdOf(data: unknown): string | null {
  const defId = (data as { defId?: unknown } | undefined)?.defId;
  return typeof defId === "string" ? defId : null;
}

/** 手札のカードをつかめるようにする。指せる手に出てこないカードはつかませない。 */
export function useCardGrip(
  defId: string,
  instanceId: string,
): { attach: (element: Element | null) => void; grippable: boolean } {
  const grippable = use(CardDrag)?.plan.has(defId) === true;
  const { ref } = useDraggable({ id: `card ${instanceId}`, data: { defId }, disabled: !grippable });
  return { attach: ref, grippable };
}

/**
 * 盤面の落とす先にする要素の ref と、その要素の `data-drop`。つかんでいるカードをここへ落とせるあいだは
 * `ready`、上に来ているあいだは `over` になる。
 */
export function useDropSpot(spot: DropSpot): {
  attach: (element: Element | null) => void;
  drop: "ready" | "over" | undefined;
} {
  const state = use(CardDrag);
  const plan = state?.plan;
  const accepts = useCallback(
    (defId: string | null) => defId !== null && plan?.get(defId)?.has(spot) === true,
    [plan, spot],
  );
  const accept = useCallback(
    (source: { data: unknown }) => accepts(defIdOf(source.data)),
    [accepts],
  );
  // 決まりのままでは、ポインタが外れていても、つかんでいるカードの面と重なる先へ落ちる。
  const { ref, isDropTarget } = useDroppable({
    id: spot,
    accept,
    collisionDetector: pointerIntersection,
  });
  const ready = accepts(state?.held?.defId ?? null);
  return { attach: ref, drop: !ready ? undefined : isDropTarget ? "over" : "ready" };
}
