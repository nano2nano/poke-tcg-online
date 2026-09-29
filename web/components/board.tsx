/**
 * 盤面を卓の配置で描く部品。座席、観戦、リプレイの画面が同じものを使う。
 *
 * **盤面の判断を一切持たない。** 射影が運んだ値を並べるだけで、権威はサーバの局面にある
 * （`docs/spec/battle-server.md` 1 節の S-1）。
 */

import {
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
import { MOVE_SECONDS, SETTLE_MS } from "../lib/motion.js";
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
  /** 山札から選ぶ効果で並べたカードが、いま選べるか。 */
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
  useArrival(face, use(Arrivals).cards.get(instanceId ?? ""));
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

/**
 * 前の局面で盤面のどこにも見えていなかったカードが、どちらの側のどこから来たか。山札とサイドのカードと、
 * 伏せた手札のカードは射影にカードの ID が無いので、`layoutId` では動かせない。
 */
interface Arrival {
  side: "near" | "far";
  zone: "prizes" | "deck" | "hand";
}

interface BoardArrivals {
  cards: ReadonlyMap<string, Arrival>;
  /** 伏せた手札で、この局面に引いたカードの位置（何枚目から）と来た場所。 */
  backs: Partial<Record<Arrival["side"], { from: number; zone: Arrival["zone"] }>>;
}

const Arrivals = createContext<BoardArrivals>({ cards: new Map(), backs: {} });

/**
 * 局面が変わって盤面に新しく見えたカードと、来た場所を決める。サイドと山札のどちらか一方だけが減っていれば、
 * 手札に入ったカードはそこから来たとみなす。伏せた手札が減り、山札もサイドも変わっていなければ、場に新しく
 * 見えたカードはその手札から出たとみなす。どちらとも決まらなければ動かさない。
 */
function boardArrivals(before: BoardSides, after: BoardSides): BoardArrivals {
  const cards = new Map<string, Arrival>();
  const backs: BoardArrivals["backs"] = {};
  const played: Arrival["side"][] = [];
  const shown = new Set(shownIds(before));
  const unseen = (list: readonly CardInstance[]) =>
    list.filter((card) => !shown.has(card.instanceId));
  for (const side of ["near", "far"] as const) {
    const [was, now] = [before[side], after[side]];
    if (was === null || now === null) continue;
    const [prizes, deck] = [now.prizeCount < was.prizeCount, now.deckCount < was.deckCount];
    const zone = prizes ? "prizes" : "deck";
    if ("hand" in now) {
      if (prizes !== deck) {
        for (const card of unseen(now.hand)) cards.set(card.instanceId, { side, zone });
      }
      continue;
    }
    const change = now.handCount - handCount(was);
    if (change > 0 && prizes !== deck) {
      // 手札から出たカードがあると、手札の増えた数は引いた数より少ない。減った山札かサイドの数だけ動かす。
      const drawn = prizes ? was.prizeCount - now.prizeCount : was.deckCount - now.deckCount;
      backs[side] = { from: Math.max(now.handCount - drawn, 0), zone };
    }
    // 観戦で戻って見るときは、手札が減って山札が増えることがある。
    if (change < 0 && now.deckCount === was.deckCount && now.prizeCount === was.prizeCount) {
      played.push(side);
      for (const card of unseen(fieldCards(now)))
        cards.set(card.instanceId, { side, zone: "hand" });
    }
  }
  // スタジアムはどちらの側にも置かれないので、伏せた手札から出したのが片方だけのときに限り、その手札から動かす。
  if (played.length === 1) {
    for (const card of unseen(stadiumCards(after.stadium))) {
      cards.set(card.instanceId, { side: played[0]!, zone: "hand" });
    }
  }
  return { cards, backs };
}

function handCount(side: Side): number {
  return "hand" in side ? side.hand.length : side.handCount;
}

interface BoardSides {
  near: Side | null;
  far: Side | null;
  stadium: SpectatorView["stadium"];
}

/** 手札のほかで、1 人ぶんの場に見えているカード。 */
function fieldCards(side: Side): CardInstance[] {
  const pokemon = [side.active, ...side.bench].filter(
    (each): each is Extract<Pokemon, { inPlayId: string }> => each !== null && "inPlayId" in each,
  );
  return [
    ...side.discard,
    ...side.lostZone,
    ...pokemon.flatMap((each) => [...each.stack, ...each.attached]),
  ];
}

function stadiumCards(stadium: SpectatorView["stadium"]): CardInstance[] {
  if (stadium === null) return [];
  return "instanceId" in stadium ? [stadium] : [stadium.left, stadium.right];
}

/** 盤面に見えているカードの ID。 */
function shownIds({ near, far, stadium }: BoardSides): string[] {
  const sides = [near, far].filter((side) => side !== null);
  return [
    ...sides.flatMap((side) => [...("hand" in side ? side.hand : []), ...fieldCards(side)]),
    ...stadiumCards(stadium),
  ].map((card) => card.instanceId);
}

/**
 * 新しく見えたカードを、来た場所から動かす。来た場所は描き始めたときに決め、そのあと局面が進んでも、
 * 動いている途中で止めない。演出を切っているときに見えたカードは、あとで演出を戻しても動かさない。
 */
function useArrival(element: RefObject<HTMLElement | null>, arrival: Arrival | undefined) {
  const on = useMotionOn();
  const [from] = useState(() => (on ? arrival : undefined));
  useLayoutEffect(() => {
    if (from === undefined || element.current === null) return;
    return arrive(element.current, from);
  }, [element, from]);
}

/**
 * Motion が動かす `transform` とぶつからないよう、`translate` を Web Animations で動かす。
 * 向かいの側は、卓を挟んで見たとおりに返して描いている（`SideBoard` の `mirrored`）。
 */
function arrive(card: HTMLElement, { side, zone }: Arrival): (() => void) | undefined {
  const mat = card
    .closest(".board")
    ?.querySelector(side === "far" ? ".mat.mirrored" : ".mat:not(.mirrored)");
  const source =
    zone === "hand"
      ? mat?.parentElement?.querySelector(':scope > [data-zone="hand"]')
      : mat?.querySelector(`[data-zone="${zone}"]`);
  if (source === null || source === undefined) return;
  const [start, end] = [source.getBoundingClientRect(), card.getBoundingClientRect()];
  const dx = start.left + start.width / 2 - (end.left + end.width / 2);
  const dy = start.top + start.height / 2 - (end.top + end.height / 2);
  card.setAttribute("data-moving", "arriving");
  const animation = card.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
    duration: MOVE_SECONDS * 1_000,
    easing: "ease-out",
  });
  const settle = () => card.removeAttribute("data-moving");
  animation.addEventListener("finish", settle);
  animation.addEventListener("cancel", settle);
  return () => animation.cancel();
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
  const zoomable = useZoomable({
    title: nameOf(table, top.defId),
    defIds: [
      ...pokemon.stack.map((card) => card.defId).reverse(),
      ...pokemon.attached.map((card) => card.defId),
    ],
  });
  // ダメージの印やついているカードも、ポケモンと一緒に動かす。
  return (
    <motion.div
      ref={attach}
      layoutId={`pokemon ${pokemon.inPlayId}`}
      layoutDependency={frame}
      {...moving}
      className={aimed.has(pokemon.inPlayId) ? "pokemon aimed zoomable" : "pokemon zoomable"}
      {...zoomable}
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
  drops,
  children,
}: {
  name: string;
  near: Side | null;
  far: Side | null;
  stadium: SpectatorView["stadium"];
  /** 手札のカードをつかんで落とし、手を指せる盤面なら渡す。 */
  drops?: CardDrops;
  children: ReactNode;
}) {
  const frame = useMemo(() => ({ near, far, stadium }), [near, far, stadium]);
  // 前に描いた局面と比べて、新しく見えたカードを決める。
  const [shown, setShown] = useState<{ sides: BoardSides; arrivals: BoardArrivals }>(() => ({
    sides: { near, far, stadium },
    arrivals: { cards: new Map(), backs: {} },
  }));
  if (shown.sides.near !== near || shown.sides.far !== far || shown.sides.stadium !== stadium) {
    const sides = { near, far, stadium };
    setShown({ sides, arrivals: boardArrivals(shown.sides, sides) });
  }
  const body = <BoardBody frame={frame}>{children}</BoardBody>;
  return (
    <LayoutGroup id={name}>
      <BoardFrame value={frame}>
        <Arrivals value={shown.arrivals}>
          {drops === undefined ? (
            body
          ) : (
            <CardDragArea drops={drops} overlay={heldCard}>
              {body}
            </CardDragArea>
          )}
        </Arrivals>
      </BoardFrame>
    </LayoutGroup>
  );
}

function BoardBody({ frame, children }: { frame: object; children: ReactNode }) {
  const taps = useTapArea();
  return (
    // 広い画面では盤面の中がスクロールする。送った量を差し引かないと、動き始めの位置がずれる。
    <motion.div className="board" layoutScroll layoutDependency={frame} {...taps}>
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
        <Zone name="deck" label="山札" count={side.deckCount}>
          {side.deckCount > 0 ? <CardBack /> : <EmptySlot />}
        </Zone>
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
      zoom={{ title: "手札", defIds: [card.defId] }}
    />
  );
}

function GripCard({ card }: { card: CardInstance }) {
  const { attach, grippable, picked } = useCardGrip(card.defId, card.instanceId);
  return (
    <CardFace
      defId={card.defId}
      instanceId={card.instanceId}
      zoom={{ title: "手札", defIds: [card.defId] }}
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
function HiddenHandCard({ index, side }: { index: number; side: Arrival["side"] }) {
  const back = useRef<HTMLDivElement>(null);
  const drawn = use(Arrivals).backs[side];
  const on = useMotionOn();
  // 演出を切っているときに引いたカードは、あとで演出を戻しても動かさない。
  const start = useEffectEvent((element: HTMLElement, zone: Arrival["zone"]) => {
    if (on) arrive(element, { side, zone });
  });
  useLayoutEffect(() => {
    if (drawn === undefined || index < drawn.from || back.current === null) return;
    start(back.current, drawn.zone);
  }, [drawn, index]);
  return <div ref={back} className="card back" />;
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
          zoom={{ title: "スタジアム", defIds: [stadium.defId] }}
        />
      ) : (
        [stadium.left, stadium.right].map((card) => (
          <CardFace
            key={card.instanceId}
            defId={card.defId}
            instanceId={card.instanceId}
            zoom={{ title: "スタジアム", defIds: [card.defId] }}
          />
        ))
      )}
    </Zone>
  );
});
