/**
 * 手札のカードをつかんで盤面へ落とし、手を指す。dnd-kit を使うのはこのファイルだけにする。
 * dnd-kit の React 版はまだ 0.x なので、差し替えるときに直す場所をここに閉じておく。
 *
 * つかめるのは指せる手に出てくるカードだけで、落とせる先はその手が向かう先だけである。
 * どちらも座席の画面が渡す表（`DropPlan`）で決まり、ここでは盤面の判断をしない。
 *
 * タッチでは、長押しのプレビューとページのスクロールが同じ操作を取り合うので、つかませない。
 * 代わりに、カードを押してから落とせる先を押すと、そこへ落としたことにする。
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
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

/** タッチで押して選んだ手札のカード。 */
interface Picked {
  defId: string;
  instanceId: string;
}

/** 押された要素から、手札のカードと落とす先を引く表。外された要素は引かれないので消さない。 */
interface Marks {
  grips: WeakMap<Element, Picked>;
  spots: WeakMap<Element, DropSpot>;
}

interface CardDragState {
  plan: DropPlan;
  held: Held | null;
  picked: Picked | null;
  marks: Marks;
}

const CardDrag = createContext<CardDragState | null>(null);

/** 盤面の要素に付ける、タッチの押し方を受ける属性。 */
interface TapHandlers {
  onPointerDownCapture: (event: PointerEvent) => void;
  onClickCapture: (event: MouseEvent) => void;
}

/** 押し方の受け口が読む、いまの表と選んでいるカード。 */
interface TapLatest {
  plan: DropPlan;
  picked: Picked | null;
  onDrop: CardDrops["onDrop"];
}

// 盤面の要素が読むので、カードを選んだりつかんだりするたびに盤面全体を描き直さないよう、別に配る。
const Taps = createContext<TapHandlers | null>(null);

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
  const [picked, setPicked] = useState<Picked | null>(null);
  // 指せる手が変わったら、選んでいたカードを放す。手を送ったあとも、ここで放す。
  const [pickedFor, setPickedFor] = useState(plan);
  if (pickedFor !== plan) {
    setPickedFor(plan);
    setPicked(null);
  }
  const [marks] = useState<Marks>(() => ({ grips: new WeakMap(), spots: new WeakMap() }));
  const state = useMemo(() => ({ plan, held, picked, marks }), [plan, held, picked, marks]);
  // 座席の画面は描き直すたびに `onDrop` を作り直す。受け口は作り直さず、いまの値をここから読む。
  const latest = useRef<TapLatest>({ plan, picked, onDrop: drops.onDrop });
  useLayoutEffect(() => {
    latest.current = { plan, picked, onDrop: drops.onDrop };
  });
  const area = useRef<Element | null>(null);
  const lastDown = useRef("");
  const taps = useMemo<TapHandlers>(
    () => ({
      onPointerDownCapture: (event) => {
        area.current = event.currentTarget;
        lastDown.current = event.pointerType;
      },
      onClickCapture: (event) => {
        const down = lastDown.current;
        lastDown.current = "";
        tap(event, down, latest.current, setPicked, marks);
      },
    }),
    [marks],
  );
  // 盤面の外を押したときと Esc でも放す。落とす先を光らせたまま残さない。
  useEffect(() => {
    if (picked === null) return;
    const release = (event: Event) => {
      const outside =
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !(event.target instanceof Node && area.current?.contains(event.target) === true);
      if (outside) setPicked(null);
    };
    document.addEventListener("click", release, { capture: true });
    document.addEventListener("keydown", release, { capture: true });
    return () => {
      document.removeEventListener("click", release, { capture: true });
      document.removeEventListener("keydown", release, { capture: true });
    };
  }, [picked]);
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
    const keys = dropKeys(plan, defId, spot);
    if (keys !== null) drops.onDrop(keys);
  };

  return (
    <DragDropProvider
      sensors={SENSORS}
      plugins={PLUGINS}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <CardDrag value={state}>
        <Taps value={taps}>{children}</Taps>
      </CardDrag>
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

/** `defId` のカードを `spot` へ落としたときに指せる手。落とせなければ null。 */
function dropKeys(plan: DropPlan, defId: string, spot: DropSpot): readonly string[] | null {
  const keys = plan.get(defId)?.get(spot);
  return keys !== undefined && keys.length > 0 ? keys : null;
}

/**
 * タッチで押したときの振る舞い。`down` は、そのクリックの前に盤面で押したポインタの種類。
 *
 * - 手札のつかめるカードを押すと、そのカードを選ぶ。もう 1 度押すと放して、いつもどおり大きく出す。
 * - 選んでいるあいだに落とせる先を押すと、そこへ落とす。盤面のほかを押すと放すだけにする。
 *   盤面に重ねたボタン（`data-tap-through`）は、放したうえで押したことにする。
 */
function tap(
  event: MouseEvent,
  down: string,
  { plan, picked, onDrop }: TapLatest,
  setPicked: (picked: Picked | null) => void,
  { grips, spots }: Marks,
) {
  // キーボードで押したクリックは、ポインタを使っていない（`detail` が 0）。クリックが `pointerType` を
  // 持たないブラウザでは、直前に盤面で押したポインタを使う。
  const native = event.nativeEvent as Partial<globalThis.PointerEvent>;
  const pointer =
    typeof native.pointerType === "string" && native.pointerType !== ""
      ? native.pointerType
      : event.detail > 0
        ? down
        : "";
  if (pointer !== "touch") {
    setPicked(null);
    return;
  }
  const card = closestMarked(event, grips);
  if (card !== null) {
    if (picked?.instanceId === card.instanceId) {
      setPicked(null);
      return;
    }
    if (plan.has(card.defId)) {
      setPicked(card);
      event.stopPropagation();
      return;
    }
  }
  if (picked === null) return;
  setPicked(null);
  // 盤面に重ねたボタン（番を終えるなど）は、放すだけにせず 1 度で押させる。
  if (event.target instanceof Element && event.target.closest("[data-tap-through]") !== null)
    return;
  event.stopPropagation();
  // ベンチのポケモンの上を押しても、たねポケモンならベンチへ出す。落とせる先に当たるまで外側へたどる。
  const spot = closestMarked(event, spots, (each) => dropKeys(plan, picked.defId, each) !== null);
  const keys = spot === null ? null : dropKeys(plan, picked.defId, spot);
  if (keys !== null) onDrop(keys);
}

/** 押された要素から盤面の要素まで外側へたどり、`marked` に載っていて `accepts` を満たす最初の印。 */
function closestMarked<T>(
  event: MouseEvent,
  marked: WeakMap<Element, T>,
  accepts: (mark: T) => boolean = () => true,
): T | null {
  const target = event.target instanceof Element ? event.target : null;
  for (let node = target; node !== null; node = node.parentElement) {
    const mark = marked.get(node);
    if (mark !== undefined && accepts(mark)) return mark;
    if (node === event.currentTarget) return null;
  }
  return null;
}

/** 盤面の要素に付ける、タッチでカードを選んで落とすための属性。つかんで落とす範囲の外では何もしない。 */
export function useTapArea(): Partial<TapHandlers> {
  return use(Taps) ?? {};
}

function defIdOf(data: unknown): string | null {
  const defId = (data as { defId?: unknown } | undefined)?.defId;
  return typeof defId === "string" ? defId : null;
}

/** 手札のカードをつかめるようにする。指せる手に出てこないカードはつかませない。 */
export function useCardGrip(
  defId: string,
  instanceId: string,
): { attach: (element: Element | null) => void; grippable: boolean; picked: boolean } {
  const state = use(CardDrag);
  const grippable = state?.plan.has(defId) === true;
  const { ref } = useDraggable({ id: `card ${instanceId}`, data: { defId }, disabled: !grippable });
  const mark = useMemo(() => ({ defId, instanceId }), [defId, instanceId]);
  const attach = useMarked(ref, state?.marks.grips, mark);
  return { attach, grippable, picked: state?.picked?.instanceId === instanceId };
}

/** dnd-kit の ref に渡しつつ、押された要素から引けるように `marked` へ載せる。 */
function useMarked<T>(
  ref: (element: Element | null) => void,
  marked: WeakMap<Element, T> | undefined,
  mark: T,
): (element: Element | null) => void {
  return useCallback(
    (element: Element | null) => {
      ref(element);
      if (element !== null) marked?.set(element, mark);
    },
    [ref, marked, mark],
  );
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
  const attach = useMarked(ref, state?.marks.spots, spot);
  const ready = accepts(state?.held?.defId ?? state?.picked?.defId ?? null);
  return { attach, drop: !ready ? undefined : isDropTarget ? "over" : "ready" };
}
