/**
 * 盤面を卓の配置で描く部品。座席、観戦、リプレイの画面が同じものを使う。
 *
 * **盤面の判断を一切持たない。** 射影が運んだ値を並べるだけで、権威はサーバの局面にある
 * （`docs/spec/battle-server.md` 1 節の S-1）。
 */

import {
  Component,
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { LayoutGroup, motion } from "motion/react";
import type { CardInstance, SpectatorView } from "../../src/engine.js";
import { imageUrl, releaseImage, takeImage } from "../lib/card-images.js";
import { useCardData } from "../lib/cards.js";
import { cardSubtitle, conditionName, describeCard, nameOf, type Side } from "../lib/describe.js";
import {
  ACTIVE_SPOT,
  BENCH_SPOT,
  PLAY_SPOT,
  pokemonSpot,
  type DropSpot,
} from "../lib/card-drops.js";
import { MOVE_EASING, MOVE_MS, SETTLE_MS, staggerMs } from "../lib/motion.js";
import {
  boardMoves,
  handCount,
  NO_MOVES,
  type BoardMoves,
  type BoardSide,
  type BoardSides,
  type Move,
  type Place,
} from "../lib/board-moves.js";
import { handSubject, pokemonSubject, STADIUM_SUBJECT } from "../lib/card-menu.js";
import { useZoomable, type ZoomTarget } from "../lib/zoom.js";
import {
  CardDragArea,
  useCardGrip,
  useDropSpot,
  useInDragArea,
  useTapArea,
  type CardDrops,
} from "./card-drag.js";
import { useMotionOn } from "./motion-setting.js";

type Pokemon = NonNullable<Side["active"]>;

export type AimedSet = ReadonlySet<string>;
export const NOTHING_AIMED: AimedSet = new Set();

/** 卓では、ねむりは左へ、マヒは右へ倒し、こんらんは逆さにして示す。それに合わせてカードを傾ける。 */
const POSTURE_ANGLES: Readonly<Record<string, number>> = {
  asleep: -90,
  paralyzed: 90,
  confused: 180,
};

/**
 * カード 1 枚。名前と種類の面を敷き、画像を出すときはその上に重ねる。
 * 画像が読めなければ外して、下の面をそのまま見せる。
 */
export function CardFace({
  defId,
  instanceId,
  posture,
  pickable,
  thumb,
  zoom,
  gripRef,
  grippable,
  picked,
  onImageFailed,
}: {
  defId: string;
  /** 卓に出ているカードの ID。同じ ID のカードが別の場所に描かれたら、前の場所から動かして見せる。 */
  instanceId?: string;
  posture?: string | undefined;
  /** 効果で選ぶカードとして並べたカードが、いま選べるか。 */
  pickable?: boolean;
  /** 一覧の行に添える小さな面。 */
  thumb?: boolean;
  zoom?: ZoomTarget;
  /** つかんで盤面へ落とせる手札のカードなら、つかむ側へ要素を渡す。 */
  gripRef?: (element: Element | null) => void;
  /** いま、つかんで盤面へ落とせるか。 */
  grippable?: boolean;
  /** タッチで押して、落とす先を選んでいるところか。 */
  picked?: boolean;
  onImageFailed?: () => void;
}) {
  const { table, images } = useCardData();
  const card = table[defId];
  const src = imageUrl(images, card?.cardID);
  // 読めなかった画像は `imageUrl` が覚えているので、描き直せば名前の面になる。
  const [, noteFailedImage] = useReducer((count: number) => count + 1, 0);
  const face = useRef<HTMLDivElement>(null);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      face.current = element;
      gripRef?.(element);
    },
    [gripRef],
  );
  const frame = use(BoardFrame);
  const moving = useMovingMark(face, frame);
  useArrival(face, use(Moves).arrivals.get(instanceId ?? ""));
  const zoomable = useZoomable(zoom);
  const failed = useEffectEvent(() => {
    noteFailedImage();
    onImageFailed?.();
  });
  // ほかの部品のクリーンアップで手放された要素を拾い、描画より前に付けるため `useLayoutEffect` にする。
  // `useEffect` では、名前の面が一瞬見える。
  useLayoutEffect(() => {
    if (src === null || face.current === null) return;
    const image = takeImage(src, () => failed());
    face.current.append(image);
    return () => releaseImage(image);
  }, [src]);
  // 画像の無い小さな面は名前も読めないので、出さない。
  if (thumb === true && src === null) return null;
  const classes = ["card", thumb === true && "thumb", zoom !== undefined && "zoomable"];
  const props = {
    ref: attach,
    className: classes.filter(Boolean).join(" "),
    ...zoomable,
    "data-def-id": defId,
    "data-instance-id": instanceId,
    "data-kind": card?.kind ?? "",
    "data-type": card?.type,
    "data-half": card?.stadiumHalf,
    "data-pickable": pickable === undefined ? undefined : String(pickable),
    "data-grippable": grippable === true ? "" : undefined,
    "data-picked": picked === true ? "" : undefined,
  };
  const children = (
    <>
      <span className="card-name">{card?.name ?? defId}</span>
      <span className="card-sub">{cardSubtitle(card)}</span>
      {/* 読み上げでは、同じ名前の別のカードを見分けられるよう、種類と収録まで読む。 */}
      {card !== undefined && <span className="visually-hidden">{describeCard(card)}</span>}
      {pickable === false && <span className="visually-hidden">（選べません）</span>}
    </>
  );
  // 一覧や拡大のカードは動かさない。デッキを組む画面では数百枚になる。
  if (instanceId === undefined) return <div {...props}>{children}</div>;
  return (
    <motion.div
      {...props}
      layoutId={instanceId}
      layoutDependency={frame}
      // 倒すのは動かさずに描く。プレビューは描いた直後のカードの大きさで置き場所を決める。
      style={{ rotate: POSTURE_ANGLES[posture ?? ""] ?? 0 }}
      {...moving}
    >
      {children}
    </motion.div>
  );
}

/**
 * 動いているあいだ要素に `data-moving` を付ける。この局面で別の場所から来たものは `arriving`、同じ
 * 場所の中で詰めて動くだけのものは `shifting` にする。CSS は来たものをほかのカードの上に描き、
 * プレビューは外れたときに置き直す。
 */
function useMovingMark(element: RefObject<HTMLElement | null>, frame: object | undefined) {
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(settling.current), []);
  const mountedIn = useRef(frame);
  const latest = useRef(frame);
  useLayoutEffect(() => {
    latest.current = frame;
  });
  const settle = () => {
    clearTimeout(settling.current);
    element.current?.removeAttribute("data-moving");
  };
  return {
    onLayoutAnimationStart: () => {
      const arriving = mountedIn.current === latest.current;
      element.current?.setAttribute("data-moving", arriving ? "arriving" : "shifting");
      // Motion は動きを途中で打ち切ると（画面の幅が変わったときなど）終わりを知らせないので、
      // 長さが過ぎたら外す。
      clearTimeout(settling.current);
      settling.current = setTimeout(settle, SETTLE_MS);
    },
    onLayoutAnimationComplete: settle,
  };
}

const Moves = createContext<BoardMoves>(NO_MOVES);

/**
 * 新しく見えたカードを、来た場所から動かす。来た場所は描き始めたときに決め、そのあと局面が進んでも、
 * 動いている途中で止めない。
 */
function useArrival(element: RefObject<HTMLElement | null>, arrival: Move | undefined) {
  const [from] = useState(arrival);
  useLayoutEffect(() => {
    if (from === undefined || element.current === null) return;
    return arrive(element.current, from);
  }, [element, from]);
}

/** 山札、サイド、手札などの場所の要素。向かいの側は、卓を挟んで見たとおりに返して描いている（`SideBoard` の `mirrored`）。 */
function placeElement(board: Element, { side, zone }: Place): Element | null {
  const mat = board.querySelector(side === "far" ? ".mat.mirrored" : ".mat:not(.mirrored)");
  if (mat === null) return null;
  return zone === "hand"
    ? (mat.parentElement?.querySelector(':scope > [data-zone="hand"]') ?? null)
    : mat.querySelector(`[data-zone="${zone}"]`);
}

/** 2 つの要素の中心の隔たり。 */
function gapBetween(from: Element, to: Element): { x: number; y: number } {
  const [start, end] = [from.getBoundingClientRect(), to.getBoundingClientRect()];
  return {
    x: end.left + end.width / 2 - (start.left + start.width / 2),
    y: end.top + end.height / 2 - (start.top + start.height / 2),
  };
}

/** 動いているあいだは少し持ち上げる。机の上を滑らせるより、どのカードが動いているかが目に入る。 */
const LIFTED = 1.08;

/**
 * Motion が動かす `transform` とぶつからないよう、`translate` と `scale` を Web Animations で動かす。
 * 同じ場所から何枚も来るときは、1 枚ずつずらして枚数を見せる。
 */
function arrive(card: HTMLElement, { place, order }: Move): (() => void) | undefined {
  const board = card.closest(".board");
  const source = board === null ? null : placeElement(board, place);
  if (source === null) return;
  const { x, y } = gapBetween(card, source);
  card.setAttribute("data-moving", "arriving");
  const animation = card.animate(
    [
      { translate: `${x}px ${y}px`, scale: 1 },
      { scale: LIFTED, offset: 0.5 },
      { translate: "0 0", scale: 1 },
    ],
    { duration: MOVE_MS, delay: staggerMs(order), easing: MOVE_EASING, fill: "backwards" },
  );
  const settle = () => card.removeAttribute("data-moving");
  animation.addEventListener("finish", settle);
  animation.addEventListener("cancel", settle);
  return () => animation.cancel();
}

/**
 * 見えなくなるカードの写しを、描き替える前の位置に作る。描き替えたあとでは、元の要素は外され、
 * 画像も手放している。傾きは外し、大きさは傾けたぶんを含まない元の要素の大きさにする。
 */
function ghostOf(card: HTMLElement): HTMLElement {
  const ghost = card.cloneNode(true) as HTMLElement;
  const rect = card.getBoundingClientRect();
  const [width, height] = [card.offsetWidth, card.offsetHeight];
  ghost.removeAttribute("data-instance-id");
  // 動いているあいだに押されたりマウスが載ったりしても、下のカードへ通す。読み上げにも出さない。
  ghost.inert = true;
  ghost.style.cssText = "";
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${rect.left + rect.width / 2 - width / 2}px`,
    top: `${rect.top + rect.height / 2 - height / 2}px`,
    margin: "0",
    zIndex: "9",
  });
  ghost.style.setProperty("--w", `${width}px`);
  ghost.setAttribute("data-moving", "arriving");
  return ghost;
}

/**
 * 写しを行き先へ動かして消す。山札や伏せた手札へ入るカードは要素ごと消えるので、写しが無いと
 * どこへ行ったかが分からない。写しは盤面の外に置き、盤面の描き直しに巻き込まない。
 */
function depart(ghost: HTMLElement, target: Element, order: number): Animation {
  document.body.append(ghost);
  // 手札とサイドでは、増えたカードは後ろに並ぶ。
  const landing = [...target.querySelectorAll(".card")].at(-1) ?? null;
  const { x, y } = gapBetween(ghost, landing ?? target);
  const scale = landing === null ? 1 : landing.getBoundingClientRect().width / ghost.offsetWidth;
  const animation = ghost.animate(
    [
      { translate: "0 0", scale: 1, opacity: 1 },
      { scale: LIFTED, offset: 0.4 },
      { opacity: 1, offset: 0.75 },
      { translate: `${x}px ${y}px`, scale, opacity: 0 },
    ],
    { duration: MOVE_MS, delay: staggerMs(order), easing: MOVE_EASING, fill: "backwards" },
  );
  const remove = () => ghost.remove();
  animation.addEventListener("finish", remove);
  animation.addEventListener("cancel", remove);
  return animation;
}

interface Leaving {
  ghost: HTMLElement;
  move: Move;
}

/**
 * 局面が変わって見えなくなるカードを、行き先へ動かす。消える要素の位置は、描き替える前にしか測れないので、
 * React が DOM を変える直前に呼ぶ `getSnapshotBeforeUpdate` で測る。関数の部品にはこれに当たるフックが無い。
 */
class Departures extends Component<{
  moves: BoardMoves;
  board: RefObject<HTMLElement | null>;
  children: ReactNode;
}> {
  private readonly ghosts = new Set<Animation>();

  override getSnapshotBeforeUpdate(previous: Readonly<{ moves: BoardMoves }>): Leaving[] | null {
    const { moves, board } = this.props;
    const area = board.current;
    if (previous.moves === moves || area === null) return null;
    return [...moves.departures].flatMap(([id, move]) => {
      const card = area.querySelector<HTMLElement>(`.card[data-instance-id="${CSS.escape(id)}"]`);
      return card === null ? [] : [{ ghost: ghostOf(card), move }];
    });
  }

  override componentDidUpdate(
    previous: Readonly<{ moves: BoardMoves }>,
    _state: unknown,
    leaving: Leaving[] | null,
  ) {
    // 演出を切ったら、動いている写しも消す。写しは盤面の外にあり、CSS では止まらない。
    if (this.props.moves === NO_MOVES && previous.moves !== NO_MOVES) this.cancel();
    const area = this.props.board.current;
    if (leaving === null || area === null) return;
    for (const { ghost, move } of leaving) {
      const target = placeElement(area, move.place);
      if (target === null) continue;
      const animation = depart(ghost, target, move.order);
      this.ghosts.add(animation);
      animation.addEventListener("finish", () => this.ghosts.delete(animation));
    }
  }

  override componentWillUnmount() {
    this.cancel();
  }

  private cancel() {
    for (const animation of this.ghosts) animation.cancel();
    this.ghosts.clear();
  }

  override render() {
    return this.props.children;
  }
}

/** 名前と、種類やワザの説明。画像が無くても、何のカードか読めるようにする。 */
export function CardCaption({ defId }: { defId: string }) {
  const { table } = useCardData();
  return (
    <>
      <strong>{nameOf(table, defId)}</strong> {describeCard(table[defId])}
    </>
  );
}

function CardBack() {
  return <div className="card back" />;
}

function EmptySlot() {
  return <div className="card empty" />;
}

interface ZoneProps {
  name: string;
  label: string;
  count?: number | null;
  style?: CSSProperties;
  zoom?: ZoomTarget | undefined;
  /** 手札のカードをここへ落として指す手の、落とす先。 */
  drop?: DropSpot | undefined;
  children: ReactNode;
}

function Zone({ drop, ...props }: ZoneProps) {
  const inDragArea = useInDragArea();
  return drop !== undefined && inDragArea ? (
    <DropZone spot={drop} {...props} />
  ) : (
    <ZoneBox {...props} />
  );
}

function DropZone({ spot, ...props }: Omit<ZoneProps, "drop"> & { spot: DropSpot }) {
  const { attach, drop } = useDropSpot(spot);
  return <ZoneBox {...props} attach={attach} dropping={drop} />;
}

function ZoneBox({
  name,
  label,
  count = null,
  style,
  zoom,
  attach,
  dropping,
  children,
}: Omit<ZoneProps, "drop"> & {
  attach?: (element: Element | null) => void;
  dropping?: string | undefined;
}) {
  const zoomable = useZoomable(zoom);
  return (
    <div
      ref={attach}
      className={zoom === undefined ? `zone ${name}` : `zone ${name} zoomable`}
      {...zoomable}
      data-zone={name}
      data-drop={dropping}
      data-count={count === null ? undefined : String(count)}
      style={style}
    >
      {children}
      <span className="zone-label">{count === null ? label : `${label} ${count}`}</span>
    </div>
  );
}

function PileZone({ name, label, pile }: { name: string; label: string; pile: CardInstance[] }) {
  const top = pile[pile.length - 1];
  // 山は下から順に持っているので、上から並べ直す。
  const zoom =
    top === undefined
      ? undefined
      : { title: label, defIds: pile.map((card) => card.defId).reverse() };
  return (
    <Zone name={name} label={label} count={pile.length} zoom={zoom}>
      {top === undefined ? (
        <EmptySlot />
      ) : (
        <CardFace key={top.instanceId} defId={top.defId} instanceId={top.instanceId} />
      )}
    </Zone>
  );
}

/** 効果で選べるポケモンと、盤面でそのポケモンを押したときに選ぶ関数。座席の画面だけが渡す。 */
export const PokemonChoices = createContext<{
  targets: ReadonlySet<string>;
  choose: (inPlayId: string) => void;
} | null>(null);

/** いま特性を使える場のポケモン。座席の画面だけが渡す。 */
export const ReadyAbilities = createContext<ReadonlySet<string>>(new Set());

/** 場のポケモン 1 匹。ついているカードは下からのぞかせ、ダメージと特殊状態は印で出す。 */
function PokemonSlot({ pokemon, aimed }: { pokemon: Pokemon | null; aimed: AimedSet }) {
  if (pokemon === null) return <EmptySlot />;
  if ("concealed" in pokemon) return <CardBack />;
  return <ShownPokemon pokemon={pokemon} aimed={aimed} />;
}

interface ShownPokemonProps {
  pokemon: Extract<Pokemon, { inPlayId: string }>;
  aimed: AimedSet;
}

function ShownPokemon(props: ShownPokemonProps) {
  const inDragArea = useInDragArea();
  return inDragArea ? <DropPokemon {...props} /> : <PokemonBox {...props} />;
}

function DropPokemon(props: ShownPokemonProps) {
  const { attach, drop } = useDropSpot(pokemonSpot(props.pokemon.inPlayId));
  return <PokemonBox {...props} dropOn={attach} dropping={drop} />;
}

function PokemonBox({
  pokemon,
  aimed,
  dropOn,
  dropping,
}: ShownPokemonProps & {
  dropOn?: (element: Element | null) => void;
  dropping?: string | undefined;
}) {
  const { table } = useCardData();
  const self = useRef<HTMLDivElement>(null);
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      self.current = element;
      dropOn?.(element);
    },
    [dropOn],
  );
  const frame = use(BoardFrame);
  const moving = useMovingMark(self, frame);
  const top = pokemon.stack[pokemon.stack.length - 1]!;
  const posture = pokemon.conditions.find((condition) =>
    Object.hasOwn(POSTURE_ANGLES, condition.kind),
  )?.kind;
  // 効果で選べるポケモンは、押すと拡大せずに選ぶ。印刷の文字はマウスを載せるか長押しで読める。
  const choices = use(PokemonChoices);
  const choosable = choices?.targets.has(pokemon.inPlayId) === true;
  const ready = use(ReadyAbilities).has(pokemon.inPlayId);
  const zoomable = useZoomable(
    {
      title: nameOf(table, top.defId),
      defIds: [
        ...pokemon.stack.map((card) => card.defId).reverse(),
        ...pokemon.attached.map((card) => card.defId),
      ],
      subject: pokemonSubject(pokemon.inPlayId),
    },
    choosable ? () => choices?.choose(pokemon.inPlayId) : undefined,
  );
  // ダメージの印やついているカードも、ポケモンと一緒に動かす。
  return (
    <motion.div
      ref={attach}
      layoutId={`pokemon ${pokemon.inPlayId}`}
      layoutDependency={frame}
      {...moving}
      className={aimed.has(pokemon.inPlayId) ? "pokemon aimed zoomable" : "pokemon zoomable"}
      {...zoomable}
      data-choosable={choosable ? "" : undefined}
      data-in-play-id={pokemon.inPlayId}
      data-damage={pokemon.damage}
      data-drop={dropping}
    >
      {/* 上のカードが替わったら別の要素として描き、手札に見えていたカードならそこから動かす。 */}
      <CardFace
        key={top.instanceId}
        defId={top.defId}
        instanceId={top.instanceId}
        posture={posture}
      />
      <div className="marks">
        {pokemon.damage > 0 && <span className="damage">{pokemon.damage}</span>}
        {ready && <span className="ability">特性</span>}
        {pokemon.conditions.map((condition) => (
          <span key={condition.kind} className="condition">
            {conditionName(condition)}
          </span>
        ))}
      </div>
      {pokemon.attached.length > 0 && (
        <div className="attached">
          {pokemon.attached.map((card) => (
            <CardFace key={card.instanceId} defId={card.defId} instanceId={card.instanceId} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** つかんでいるあいだ、ポインタに付いて動かすカード。 */
const heldCard = (defId: string) => <CardFace defId={defId} />;

/**
 * 描いている局面。カードはこれが変わったときだけ位置を測り直す。指せる手のボタンにマウスを載せるたびに
 * 盤面を描き直すが、そのたびに全部のカードを測らない。
 */
const BoardFrame = createContext<object | undefined>(undefined);

/**
 * 卓の両側とスタジアムを並べる枠。カードを動かして見せるのは同じ枠の中だけにする。対戦とそのリプレイを
 * 同時に開くと、同じカードが 2 つの盤面に出る。
 */
export function Board({
  name,
  near,
  far,
  stadium,
  shuffled = NO_MOVES.shuffled,
  drops,
  children,
}: {
  name: string;
  near: Side | null;
  far: Side | null;
  stadium: SpectatorView["stadium"];
  /** この局面へ来るあいだに山札を切った側。 */
  shuffled?: readonly BoardSide[];
  /** 手札のカードをつかんで落とし、手を指せる盤面なら渡す。 */
  drops?: CardDrops;
  children: ReactNode;
}) {
  const frame = useMemo(() => ({ near, far, stadium }), [near, far, stadium]);
  const animate = useMotionOn();
  // 前に描いた局面と比べて、動かすカードを決める。演出を切っているときに動いたカードは、あとで演出を戻しても動かさない。
  const [shown, setShown] = useState<{ sides: BoardSides; moves: BoardMoves }>(() => ({
    sides: { near, far, stadium },
    moves: NO_MOVES,
  }));
  if (shown.sides.near !== near || shown.sides.far !== far || shown.sides.stadium !== stadium) {
    const sides = { near, far, stadium };
    setShown({ sides, moves: animate ? boardMoves(shown.sides, sides, shuffled) : NO_MOVES });
  } else if (!animate && shown.moves !== NO_MOVES) {
    // 局面の途中で演出を切ったら、決めてあった動きも捨てる。あとで演出を戻しても、前の動きをやり直さない。
    setShown({ ...shown, moves: NO_MOVES });
  }
  const area = useRef<HTMLDivElement>(null);
  const body = (
    <BoardBody frame={frame} area={area}>
      {children}
    </BoardBody>
  );
  return (
    <LayoutGroup id={name}>
      <BoardFrame value={frame}>
        <Moves value={shown.moves}>
          <Departures moves={shown.moves} board={area}>
            {drops === undefined ? (
              body
            ) : (
              <CardDragArea drops={drops} overlay={heldCard}>
                {body}
              </CardDragArea>
            )}
          </Departures>
        </Moves>
      </BoardFrame>
    </LayoutGroup>
  );
}

function BoardBody({
  frame,
  area,
  children,
}: {
  frame: object;
  area: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const taps = useTapArea();
  return (
    // 広い画面では盤面の中がスクロールする。送った量を差し引かないと、動き始めの位置がずれる。
    <motion.div ref={area} className="board" layoutScroll layoutDependency={frame} {...taps}>
      {children}
    </motion.div>
  );
}

/**
 * 1 人ぶんの場。`mirrored` は向かいに座る側で、卓を挟んで見たとおりに上下と左右を返す。
 * 手札の中身が見えない側は、射影が `hand` の代わりに `handCount` を持っている。
 *
 * 局面が変わらないあいだは描き直さない。結果の通知が出入りするたびに、卓のカードを全部描き直すことになる。
 */
export const SideBoard = memo(function SideBoard({
  side,
  mirrored,
  aimed = NOTHING_AIMED,
  drops = false,
}: {
  side: Side;
  mirrored: boolean;
  /** 手札のカードを、この側のバトル場とベンチへ落とせるか。 */
  drops?: boolean;
  /** 指せる手のボタンが狙っているポケモン。盤面のそのポケモンを囲む。 */
  aimed?: AimedSet;
}) {
  const faceUp = new Map(side.faceUpPrizes.map((prize) => [prize.index, prize.defId]));
  // ベンチの枠の数はスタジアムで変わり、射影には載っていない。空いた枠は描かない。
  const slots: readonly (Pokemon | null)[] = side.bench;
  const bench = slots.filter((pokemon) => pokemon !== null);
  const cardsInHand = handCount(side);

  const mat = (
    <div className={mirrored ? "mat mirrored" : "mat"}>
      <div className="prize-side">
        {side.lostZone.length > 0 && (
          <PileZone name="lost" label="ロストゾーン" pile={side.lostZone} />
        )}
        <Zone name="prizes" label="サイド" count={side.prizeCount}>
          <div className="prize-grid">
            {Array.from({ length: side.prizeCount }, (_, index) => {
              const defId = faceUp.get(index);
              return defId === undefined ? (
                <CardBack key={index} />
              ) : (
                <CardFace key={index} defId={defId} zoom={{ title: "サイド", defIds: [defId] }} />
              );
            })}
          </div>
        </Zone>
      </div>
      <div className="field">
        <Zone name="active" label="バトル場" drop={drops ? ACTIVE_SPOT : undefined}>
          {/* 入れ替わったポケモンは別の要素として描く。同じ要素のまま layoutId だけ変えても Motion は追わない。 */}
          <PokemonSlot
            key={side.active !== null && "inPlayId" in side.active ? side.active.inPlayId : "none"}
            pokemon={side.active}
            aimed={aimed}
          />
        </Zone>
        <Zone name="bench" label="ベンチ" drop={drops ? BENCH_SPOT : undefined}>
          {bench.length === 0 ? (
            <EmptySlot />
          ) : (
            bench.map((pokemon, index) => (
              <PokemonSlot
                key={"inPlayId" in pokemon ? pokemon.inPlayId : index}
                pokemon={pokemon}
                aimed={aimed}
              />
            ))
          )}
        </Zone>
      </div>
      <div className="piles">
        <DeckPile count={side.deckCount} side={mirrored ? "far" : "near"} />
        <PileZone name="discard" label="トラッシュ" pile={side.discard} />
      </div>
    </div>
  );

  // 入りきらない枚数のときに、どれだけ重ねるかを CSS が決める。
  const hand = (
    <Zone
      name="hand"
      label="手札"
      count={cardsInHand}
      style={{ "--cards": String(cardsInHand) } as CSSProperties}
    >
      {"hand" in side
        ? side.hand.map((card) => <HandCard key={card.instanceId} card={card} />)
        : Array.from({ length: cardsInHand }, (_, index) => (
            <HiddenHandCard key={index} index={index} side={mirrored ? "far" : "near"} />
          ))}
    </Zone>
  );

  return mirrored ? (
    <>
      {hand}
      {mat}
    </>
  ) : (
    <>
      {mat}
      {hand}
    </>
  );
});

function HandCard({ card }: { card: CardInstance }) {
  const inDragArea = useInDragArea();
  return inDragArea ? (
    <GripCard card={card} />
  ) : (
    <CardFace
      defId={card.defId}
      instanceId={card.instanceId}
      zoom={{ title: "手札", defIds: [card.defId], subject: handSubject(card.defId) }}
    />
  );
}

function GripCard({ card }: { card: CardInstance }) {
  const { attach, grippable, picked } = useCardGrip(card.defId, card.instanceId);
  return (
    <CardFace
      defId={card.defId}
      instanceId={card.instanceId}
      zoom={{ title: "手札", defIds: [card.defId], subject: handSubject(card.defId) }}
      gripRef={attach}
      grippable={grippable}
      picked={picked}
    />
  );
}

/**
 * 伏せた手札の 1 枚。位置で描くので、前の局面からあった要素も、引いたカードの位置になれば動かす。
 * 動いている途中で次の局面が届いても止めない。
 */
function HiddenHandCard({ index, side }: { index: number; side: BoardSide }) {
  const back = useRef<HTMLDivElement>(null);
  const drawn = use(Moves).backs[side];
  useLayoutEffect(() => {
    if (drawn === undefined || index < drawn.from || back.current === null) return;
    arrive(back.current, { place: { side, zone: drawn.zone }, order: index - drawn.from });
  }, [drawn, index, side]);
  return <div ref={back} className="card back" />;
}

/**
 * 山札。切ったら、2 つに分けた山を左右へ広げて重ね直して見せる。切ったことは結果の通知には出さないので、
 * 盤面で伝える。
 */
function DeckPile({ count, side }: { count: number; side: BoardSide }) {
  const moves = use(Moves);
  // 切った回数を数え、見せ終える前にまた切ったら、広げるところからやり直す。演出を切ったら見せるのをやめる。
  const [shuffles, setShuffles] = useState({ moves, started: 0, ended: 0 });
  if (shuffles.moves !== moves) {
    const started = shuffles.started + (count > 0 && moves.shuffled.includes(side) ? 1 : 0);
    setShuffles({ moves, started, ended: moves === NO_MOVES ? started : shuffles.ended });
  }
  const { started, ended } = shuffles;
  return (
    <Zone name="deck" label="山札" count={count}>
      {count > 0 ? <CardBack /> : <EmptySlot />}
      {started > ended && (
        <div
          key={started}
          className="shuffling"
          aria-hidden="true"
          onAnimationEnd={() => setShuffles((current) => ({ ...current, ended: started }))}
        >
          <div className="card back" />
          <div className="card back" />
        </div>
      )}
    </Zone>
  );
}

/** トレーナーズやスタジアムは、盤面の真ん中へ落として使う。 */
export const Stadium = memo(function Stadium({ stadium }: { stadium: SpectatorView["stadium"] }) {
  return (
    <Zone name="stadium" label="スタジアム" drop={PLAY_SPOT}>
      {stadium === null ? (
        <EmptySlot />
      ) : "instanceId" in stadium ? (
        <CardFace
          key={stadium.instanceId}
          defId={stadium.defId}
          instanceId={stadium.instanceId}
          zoom={{ title: "スタジアム", defIds: [stadium.defId], subject: STADIUM_SUBJECT }}
        />
      ) : (
        [stadium.left, stadium.right].map((card) => (
          <CardFace
            key={card.instanceId}
            defId={card.defId}
            instanceId={card.instanceId}
            zoom={{ title: "スタジアム", defIds: [card.defId], subject: STADIUM_SUBJECT }}
          />
        ))
      )}
    </Zone>
  );
});
