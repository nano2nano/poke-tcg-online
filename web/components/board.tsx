/**
 * 盤面を卓の配置で描く部品。座席、観戦、リプレイの画面が同じものを使う。
 *
 * **盤面の判断を一切持たない。** 射影が運んだ値を並べるだけで、権威はサーバの局面にある
 * （`docs/spec/battle-server.md` 1 節の S-1）。
 */

import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CardInstance, SpectatorView } from "../../src/engine.js";
import { imageUrl, releaseImage, takeImage } from "../lib/card-images.js";
import { useCardData } from "../lib/cards.js";
import { cardSubtitle, conditionName, describeCard, type Side } from "../lib/describe.js";
import { useZoomable, type ZoomTarget } from "../lib/zoom.js";

type Pokemon = NonNullable<Side["active"]>;

export type AimedSet = ReadonlySet<string>;
export const NOTHING_AIMED: AimedSet = new Set();

/** ねむり・マヒ・こんらんは、卓で向きを変えて示すのに合わせてカードを傾ける。 */
const POSTURES = new Set(["asleep", "paralyzed", "confused"]);

/**
 * カード 1 枚。名前と種類の面を敷き、画像を出すときはその上に重ねる。
 * 画像が読めなければ外して、下の面をそのまま見せる。
 */
export function CardFace({
  defId,
  posture,
  pickable,
  thumb,
  zoom,
}: {
  defId: string;
  posture?: string | undefined;
  /** 山札から選ぶ効果で並べたカードが、いま選べるか。 */
  pickable?: boolean;
  /** 一覧の行に添える小さな面。 */
  thumb?: boolean;
  zoom?: ZoomTarget;
}) {
  const { table, images } = useCardData();
  const card = table[defId];
  const src = imageUrl(images, card?.cardID);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const shown = src !== null && src !== failedSrc ? src : null;
  const face = useRef<HTMLDivElement>(null);
  const zoomable = useZoomable(zoom);
  // 描き直しの片付けより後、画面に出る前に付ける。後だと、名前の面が一瞬見える。
  useLayoutEffect(() => {
    if (shown === null || face.current === null) return;
    const image = takeImage(shown, () => setFailedSrc(shown));
    face.current.append(image);
    return () => releaseImage(image);
  }, [shown]);
  // 画像の無い小さな面は名前も読めないので、出さない。
  if (thumb === true && shown === null) return null;
  const classes = ["card", thumb === true && "thumb", zoom !== undefined && "zoomable"];
  return (
    <div
      ref={face}
      className={classes.filter(Boolean).join(" ")}
      {...zoomable}
      data-def-id={defId}
      data-kind={card?.kind ?? ""}
      data-type={card?.type}
      data-half={card?.stadiumHalf}
      data-posture={posture}
      data-pickable={pickable === undefined ? undefined : String(pickable)}
    >
      <span className="card-name">{card?.name ?? defId}</span>
      <span className="card-sub">{cardSubtitle(card)}</span>
      {/* 読み上げでは、同じ名前の別のカードを見分けられるよう、種類と収録まで読む。 */}
      {card !== undefined && <span className="visually-hidden">{describeCard(card)}</span>}
      {pickable === false && <span className="visually-hidden">（選べません）</span>}
    </div>
  );
}

export function CardBack() {
  return <div className="card back" />;
}

export function EmptySlot() {
  return <div className="card empty" />;
}

export function Zone({
  name,
  label,
  count = null,
  style,
  zoom,
  children,
}: {
  name: string;
  label: string;
  count?: number | null;
  style?: CSSProperties;
  zoom?: ZoomTarget | undefined;
  children: ReactNode;
}) {
  const zoomable = useZoomable(zoom);
  return (
    <div
      className={zoom === undefined ? `zone ${name}` : `zone ${name} zoomable`}
      {...zoomable}
      data-zone={name}
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
  // 上から順に並べる。
  const zoom = { title: label, defIds: pile.map((card) => card.defId).reverse() };
  return (
    <Zone name={name} label={label} count={pile.length} zoom={top === undefined ? undefined : zoom}>
      {top === undefined ? <EmptySlot /> : <CardFace defId={top.defId} />}
    </Zone>
  );
}

/** 場のポケモン 1 匹。ついているカードは下からのぞかせ、ダメージと特殊状態は印で出す。 */
function PokemonSlot({ pokemon, aimed }: { pokemon: Pokemon | null; aimed: AimedSet }) {
  if (pokemon === null) return <EmptySlot />;
  if ("concealed" in pokemon) return <CardBack />;
  return <ShownPokemon pokemon={pokemon} aimed={aimed} />;
}

function ShownPokemon({
  pokemon,
  aimed,
}: {
  pokemon: Extract<Pokemon, { inPlayId: string }>;
  aimed: AimedSet;
}) {
  const { table } = useCardData();
  const top = pokemon.stack[pokemon.stack.length - 1]!;
  const posture = pokemon.conditions.find((condition) => POSTURES.has(condition.kind))?.kind;
  const zoomable = useZoomable({
    title: table[top.defId]?.name ?? top.defId,
    defIds: [
      ...pokemon.stack.map((card) => card.defId).reverse(),
      ...pokemon.attached.map((card) => card.defId),
    ],
  });
  return (
    <div
      className={aimed.has(pokemon.inPlayId) ? "pokemon aimed zoomable" : "pokemon zoomable"}
      {...zoomable}
      data-in-play-id={pokemon.inPlayId}
      data-damage={pokemon.damage}
    >
      <CardFace defId={top.defId} posture={posture} />
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
            <CardFace key={card.instanceId} defId={card.defId} />
          ))}
        </div>
      )}
    </div>
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
}: {
  side: Side;
  mirrored: boolean;
  /** 指せる手のボタンが狙っているポケモン。盤面のそのポケモンを囲む。 */
  aimed?: AimedSet;
}) {
  const faceUp = new Map(side.faceUpPrizes.map((prize) => [prize.index, prize.defId]));
  // ベンチの枠の数はスタジアムで変わり、射影には載っていない。空いた枠は描かない。
  const slots: readonly (Pokemon | null)[] = side.bench;
  const bench = slots.filter((pokemon) => pokemon !== null);
  const handCount = "hand" in side ? side.hand.length : side.handCount;

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
        <Zone name="active" label="バトル場">
          <PokemonSlot pokemon={side.active} aimed={aimed} />
        </Zone>
        <Zone name="bench" label="ベンチ">
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
      count={handCount}
      style={{ "--cards": String(handCount) } as CSSProperties}
    >
      {"hand" in side
        ? side.hand.map((card) => (
            <CardFace
              key={card.instanceId}
              defId={card.defId}
              zoom={{ title: "手札", defIds: [card.defId] }}
            />
          ))
        : Array.from({ length: handCount }, (_, index) => <CardBack key={index} />)}
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

export const Stadium = memo(function Stadium({ stadium }: { stadium: SpectatorView["stadium"] }) {
  return (
    <Zone name="stadium" label="スタジアム">
      {stadium === null ? (
        <EmptySlot />
      ) : "instanceId" in stadium ? (
        <CardFace defId={stadium.defId} zoom={{ title: "スタジアム", defIds: [stadium.defId] }} />
      ) : (
        [stadium.left, stadium.right].map((card) => (
          <CardFace
            key={card.instanceId}
            defId={card.defId}
            zoom={{ title: "スタジアム", defIds: [card.defId] }}
          />
        ))
      )}
    </Zone>
  );
});
