import { useEffect, useMemo, useRef, useState } from "react";
import type { Move, Player } from "../../src/engine.js";
import { useCardData } from "../lib/cards.js";
import { kindRank, nameOf, seatClockText } from "../lib/describe.js";
import {
  choicePrompt,
  describeMove,
  foldMoves,
  handCardName,
  locateCard,
  moveTargets,
  placementPrompt,
  setupPrompt,
  type MoveContext,
} from "../lib/describe-move.js";
import { NO_DROPS, planDrops } from "../lib/card-drops.js";
import { setupOffer, type SeatState } from "../lib/match-state.js";
import { watchUrl, type StoredSeat } from "../lib/seat.js";
import { useSeat, type Seating } from "../lib/use-seat.js";
import { Board, CardFace, NOTHING_AIMED, PokemonChoices, SideBoard, Stadium } from "./board.js";
import type { CardDrops } from "./card-drag.js";
import { EventLog } from "./event-log.js";
import { MotionToggle } from "./motion-setting.js";
import { NoticeLayer, useNotices } from "./notices.js";

/**
 * 座席の卓。相手を向かいに、自分を手前に置き、右の欄に指せる手を並べる。
 *
 * **盤面の判断を一切持たない。** サーバが送ってきた合法手を並べ、押された 1 つを送り返す。
 * 卓の配置の CSS は `body` の直下にある卓を探すので、外側を別の要素で包まない。
 */
export function SeatTable({
  seated,
  onLeave,
}: {
  seated: StoredSeat;
  onLeave: (reason: string, resumable: boolean) => void;
}) {
  const board = useRef<HTMLElement>(null);
  const feed = useNotices();
  const seating = useSeat(seated, feed.show);
  const { state, connection, events, shuffle, left, send } = seating;
  const { table } = useCardData();
  const { view, legalMoves, setup, deckPlacement, answerDestinations } = state;
  const context = useMemo<MoveContext>(() => ({ view, cards: table }), [view, table]);
  const listed = useMemo(
    () => listMoves({ legalMoves, setup, deckPlacement, answerDestinations }, context),
    [legalMoves, setup, deckPlacement, answerDestinations, context],
  );
  // 載っているボタンと選んだボタンを分けて持つ。同じポケモンを狙うボタンが 2 つあっても消し合わない。
  const [aim, setAim] = useState<Aim>({ hovered: null, focused: null });
  // カードを落とした先で指せる手が 2 つ以上あれば、ボタンをそれだけに絞って選ばせる。一覧が変わったら解く。
  const [narrowed, setNarrowed] = useState<readonly string[] | null>(null);
  // 一覧が変わったら、消えたボタンの狙いを捨てる。消えたボタンからはマウスが離れた知らせが来ないので、
  // 残すと、同じ手があとでまた並んだときに、載せていないのに囲む。残ったボタンの狙いはそのまま囲む。
  const [aimFor, setAimFor] = useState(listed);
  if (aimFor !== listed) {
    setAimFor(listed);
    setNarrowed(null);
    const keys = new Set(listed.buttons.map(({ key }) => key));
    const kept = (key: string | null) => (key !== null && keys.has(key) ? key : null);
    setAim((current) => ({ hovered: kept(current.hovered), focused: kept(current.focused) }));
  }
  const disabled = connection !== null;
  const plan = useMemo(() => planDrops(listed.buttons, context), [listed, context]);
  const drops: CardDrops = {
    plan: disabled || seating.awaiting ? NO_DROPS : plan,
    onDrop: (keys) => {
      if (keys.length > 1) {
        setNarrowed(keys);
        return;
      }
      const button = listed.buttons.find(({ key }) => key === keys[0]);
      if (button !== undefined) playMove(seating, listed.offered, button.move);
    },
  };
  const aimed = useMemo(() => {
    const targets = listed.buttons
      .filter(({ key }) => key === aim.hovered || key === aim.focused)
      .flatMap((button) => button.targets);
    // 空の集合を毎回作ると、盤面の memo が効かず、狙いの無いボタンに載せるたびに盤面を描き直す。
    return targets.length === 0 ? NOTHING_AIMED : new Set(targets);
  }, [listed, aim]);
  const onAim = (kind: keyof Aim, key: string | null) =>
    setAim((current) => (current[kind] === key ? current : { ...current, [kind]: key }));
  const onPlay = (move: Move) => {
    if (!seating.awaiting) playMove(seating, listed.offered, move);
  };
  const cardChoice =
    state.ended === null && view?.phase !== "setup" && isCardChoice(listed.buttons);
  const pokemonChoices = pokemonChoicesOf(listed.buttons, disabled ? null : onPlay);

  useEffect(() => {
    if (left !== null) onLeave(left.text, left.resumable);
  }, [left, onLeave]);
  if (left !== null) return null;

  const { clock, ended } = state;
  const clockText =
    ended !== null
      ? "対戦は終わりました"
      : clock !== null
        ? seatClockText(clock, state.seat)
        : // 両者がシェアを開くまで局面は届かない。
          "相手が席に着くのを待っています";

  return (
    <>
      <section
        id="table"
        className="table"
        ref={board}
        data-ended={ended === null ? undefined : ""}
        data-state-version={state.stateVersion}
      >
        <div className="table-status">
          <div id="clock" className="clock">
            {clockText}
          </div>
          {connection !== null && (
            <output id="connection" className="connection" data-state={connection.state}>
              {connection.text}
            </output>
          )}
          {shuffle !== null && (
            <p id="shuffle-check" className="note" data-result={shuffle.result}>
              {shuffle.text}
            </p>
          )}
        </div>
        <PokemonChoices value={pokemonChoices}>
          <Board
            name="seat"
            near={view?.self ?? null}
            far={view?.opponent ?? null}
            stadium={view?.stadium ?? null}
            drops={drops}
          >
            <div className="board-side">
              <h2>相手</h2>
              <div id="opponent">
                {view !== null && <SideBoard side={view.opponent} mirrored aimed={aimed} />}
              </div>
            </div>
            <div id="stadium" className="board-center">
              {view !== null && <Stadium stadium={view.stadium} />}
            </div>
            <div className="board-side">
              <h2>自分</h2>
              <div id="self">
                {view !== null && (
                  <SideBoard side={view.self} mirrored={false} aimed={aimed} drops />
                )}
              </div>
            </div>
          </Board>
        </PokemonChoices>
        {cardChoice && (
          <ChoiceSheet
            key={view?.choices.at(-1)?.choiceId}
            state={state}
            context={context}
            buttons={listed.buttons}
            disabled={disabled}
            awaiting={seating.awaiting}
            onPlay={onPlay}
          />
        )}

        <div className="table-panel">
          <Mulligans state={state} />
          <h2>指せる手</h2>
          {!cardChoice && (
            <Moves
              seating={seating}
              context={context}
              listed={listed}
              narrowed={narrowed}
              onWiden={() => setNarrowed(null)}
              disabled={disabled}
              onAim={onAim}
            />
          )}
          <button
            id="concede-button"
            className="danger"
            // 始まる前、切れているあいだ、決着のあとは、投了が通らない。押せたように見せない。
            disabled={disabled || view === null || ended !== null}
            onClick={() => {
              if (confirm("投了しますか。")) send({ t: "concede" });
            }}
          >
            投了する
          </button>
          <MotionToggle id="motion-toggle" />
          <EventLog id="event-log" listId="events" events={events} />
          <p className="note">
            観戦のリンク（渡された人は、両者の手札の中身を除いた盤面を見られます）
            <input
              id="watch-link"
              className="watch-link"
              readOnly
              // 観戦トークンは終わった対戦では通らない。残すと、渡された人が開いても入れない。
              value={
                ended === null && state.spectatorToken !== null
                  ? watchUrl(state.spectatorToken)
                  : ""
              }
            />
          </p>
        </div>
      </section>
      <NoticeLayer feed={feed} board={board} />
    </>
  );
}

interface Aim {
  hovered: string | null;
  focused: string | null;
}

interface ListedMove {
  move: Move;
  /** `legalMoves` での位置。 */
  index: number;
  /** 手から作る。局面が変わって別の手になったボタンは、別の要素として描き直し、フォーカスを残さない。 */
  key: string;
  label: string;
  targets: string[];
}

interface Listed {
  buttons: ListedMove[];
  /**
   * 畳んだときだけ、見せた手の `legalMoves` での位置を添える。記録で、見せなかった手と
   * 選ばなかった手を分けるため（6.2 節）。
   */
  offered: number[] | undefined;
}

/**
 * 並べる手。手札の同じカードを選ぶ手は 1 つに畳む。
 * 準備の状態（`setup`）があるあいだは、同じ選択を 1 手ずつ指すボタンを並べない。
 */
function listMoves(
  {
    legalMoves: moves,
    setup,
    deckPlacement,
    answerDestinations,
  }: Pick<SeatState, "legalMoves" | "setup" | "deckPlacement" | "answerDestinations">,
  context: MoveContext,
): Listed {
  if (moves === null || setup !== null) return { buttons: [], offered: undefined };
  const folded = foldMoves(moves, context);
  return {
    buttons: folded.map(({ move, index, key }) => ({
      move,
      index,
      key,
      label: describeMove(move, context, deckPlacement, answerDestinations?.[index] ?? null),
      targets: moveTargets(move),
    })),
    offered: folded.length === moves.length ? undefined : folded.map(({ index }) => index),
  };
}

/** `offered` は、見せた手の `legalMoves` での位置。すべて見せたなら undefined。 */
function playMove({ state, send }: Seating, offered: number[] | undefined, move: Move) {
  send({
    t: "move",
    stateVersion: state.stateVersion,
    move,
    ...(offered === undefined ? {} : { offered }),
  });
}

/** 対戦が終わっていれば、待ちも選ぶものも無い。 */
function Moves({
  seating,
  context,
  listed,
  narrowed,
  onWiden,
  disabled,
  onAim,
}: {
  seating: Seating;
  context: MoveContext;
  listed: Listed;
  /** カードを落とした先で指せる手。あれば、ボタンをそれだけにする。 */
  narrowed: readonly string[] | null;
  onWiden: () => void;
  disabled: boolean;
  onAim: (kind: "hovered" | "focused", key: string | null) => void;
}) {
  const { state, awaiting, send, choose } = seating;
  const { view, legalMoves: moves, setup, deckPlacement: placement } = state;
  const table = context.cards;
  const playing = state.ended === null;
  const prompt = !playing
    ? ""
    : moves !== null && placement !== null
      ? placementPrompt(placement, table)
      : setupPrompt(context, moves !== null, setup) || choicePrompt(context);

  const buttons =
    narrowed === null ? listed.buttons : listed.buttons.filter(({ key }) => narrowed.includes(key));
  // 絞ったときは、絞って見せた手だけを見せたことにする。
  const offered = narrowed === null ? listed.offered : buttons.map(({ index }) => index);

  return (
    <>
      {prompt !== "" && (
        <p id="move-prompt" className="move-prompt">
          {prompt}
        </p>
      )}
      <SetupForm
        state={state}
        send={send}
        choose={choose}
        context={context}
        disabled={disabled}
        awaiting={awaiting}
      />
      {narrowed !== null && (
        <p id="drop-prompt" className="move-prompt">
          落とした先でできる手がいくつかあります。どれにするか選んでください。{" "}
          <button id="drop-widen" className="secondary" onClick={onWiden}>
            ほかの手も出す
          </button>
        </p>
      )}
      <div id="moves" className="moves">
        {moves === null
          ? // 準備の待ちは `move-prompt` が伝える。「相手の番」と出すと、番が相手へ移ったと読まれる。
            playing && view !== null && view.phase !== "setup" && <WaitingNote state={state} />
          : buttons.map(({ move, key, label }) => (
              <button
                key={key}
                disabled={disabled}
                // 返事を待つあいだは `disabled` にしない。押したボタンからフォーカスが外れる。
                aria-disabled={awaiting}
                onClick={() => {
                  if (!awaiting) playMove(seating, offered, move);
                }}
                onPointerEnter={() => onAim("hovered", key)}
                onPointerLeave={() => onAim("hovered", null)}
                onFocus={() => onAim("focused", key)}
                onBlur={() => onAim("focused", null)}
              >
                {label}
              </button>
            ))}
      </div>
    </>
  );
}

/**
 * 手番のプレイヤーでなくても、選択を持てば手を持つ（きぜつしたあとにバトル場へ出すポケモンなど）。
 * 自分の番の途中で相手が選んでいるのを「相手の番」と出すと、番が移ったと読まれる。
 */
function WaitingNote({ state: { view } }: { state: SeatState }) {
  const ownTurn = view?.turnPlayer === view?.viewer;
  return (
    <p className="waiting" data-state={ownTurn ? "their-choice" : "their-turn"}>
      {ownTurn ? "相手が選んでいます。あなたの番は続きます" : "相手の番です"}
    </p>
  );
}

/**
 * 対戦準備のバトル場とベンチを選ぶ。選んだものは「準備を終える」で 1 度に送る。
 *
 * エンジンは準備を 1 人ずつの選択に並べて進めるが、サーバは番の来ていない座席の答えも
 * 預かる（仕様 2.4 節）。1 つずつ送る形にすると、相手の番を待つたびに止まる。
 */
function SetupForm({
  state,
  send,
  choose,
  context,
  disabled,
  awaiting,
}: {
  state: SeatState;
  send: Seating["send"];
  choose: Seating["choose"];
  context: MoveContext;
  disabled: boolean;
  awaiting: boolean;
}) {
  const offer = setupOffer(state);
  if (offer === null) return null;
  const draft = state.setupDraft;
  const full = draft.bench.length >= offer.benchSlots;
  // 送ったあとは選び直させない。画面の選択が、サーバが預かった答えと食い違う。
  const toggle = (instanceId: string, pressed: boolean, onClick: () => void, off = false) => (
    <button
      key={instanceId}
      type="button"
      className="secondary"
      data-instance-id={instanceId}
      aria-pressed={pressed}
      disabled={off}
      onClick={onClick}
    >
      {handCardName(instanceId, context)}
    </button>
  );
  return (
    <div id="setup" className="setup">
      <h3>バトル場</h3>
      <div id="setup-active" className="moves">
        {offer.active.map((id) =>
          toggle(
            id,
            draft.active === id,
            () => choose({ t: "choose-active", instanceId: id }),
            awaiting,
          ),
        )}
      </div>
      <h3>ベンチ</h3>
      <div id="setup-bench" className="moves">
        {offer.bench
          .filter((id) => id !== draft.active)
          .map((id) => {
            const chosen = draft.bench.includes(id);
            return toggle(
              id,
              chosen,
              () => choose({ t: "toggle-bench", instanceId: id }),
              awaiting || (!chosen && full),
            );
          })}
      </div>
      <button
        id="setup-submit"
        // 切れているあいだは送れない。押せるように見せない。
        disabled={disabled || awaiting || draft.active === null}
        onClick={() => {
          if (draft.active !== null) send({ t: "setup", active: draft.active, bench: draft.bench });
        }}
      >
        準備を終える
      </button>
    </div>
  );
}

/** 選択の答えのカード。カードを選ぶ答えでなければ null。 */
function answerCard(move: Move, context: MoveContext): string | null {
  if (move.type !== "AnswerChoice") return null;
  const { answer } = move;
  if (answer.kind === "cardDef") return answer.defId;
  return answer.kind === "card" ? (locateCard(answer.card, context)?.defId ?? null) : null;
}

/** 効果でカードを選ぶ選択か。カードを選ぶ答えと、選ぶのをやめる答えだけが並ぶ。 */
function isCardChoice(buttons: readonly ListedMove[]): boolean {
  const answers = buttons.map(({ move }) =>
    move.type === "AnswerChoice" ? move.answer.kind : null,
  );
  return (
    answers.some((kind) => kind === "card" || kind === "cardDef") &&
    answers.every((kind) => kind === "card" || kind === "cardDef" || kind === "decline")
  );
}

/** 効果で選べるポケモンと、盤面で押したときに指す手。選べるポケモンが無ければ null。 */
function pokemonChoicesOf(buttons: readonly ListedMove[], onPlay: ((move: Move) => void) | null) {
  const moves = new Map<string, Move>();
  for (const { move } of buttons) {
    if (move.type === "AnswerChoice" && move.answer.kind === "inPlay") {
      moves.set(move.answer.target, move);
    }
  }
  if (moves.size === 0 || onPlay === null) return null;
  return {
    targets: new Set(moves.keys()),
    choose: (inPlayId: string) => {
      const move = moves.get(inPlayId);
      if (move !== undefined) onPlay(move);
    },
  };
}

/**
 * 効果でカードを選ぶあいだ、候補を盤面の上に大きく並べ、押して選ばせる。
 *
 * 山札を見て選ぶ効果では、見ている山札をすべて並べ、選べないカードは暗くする。エンジンの候補は条件に
 * 合うカードだけなので、候補だけでは山札に何が残っていて何がサイドに落ちたかを読めない。
 * 盤面のカードは押すと拡大するが、ここの候補は押すと選ぶ。印刷の文字は、マウスを載せるか長押しで読む。
 */
function ChoiceSheet({
  state,
  context,
  buttons,
  disabled,
  awaiting,
  onPlay,
}: {
  state: SeatState;
  context: MoveContext;
  buttons: readonly ListedMove[];
  disabled: boolean;
  awaiting: boolean;
  onPlay: (move: Move) => void;
}) {
  // 選ぶカードを隠して盤面を見られるようにする。次の選択に移ったら、部品ごと作り直して開く。
  const [folded, setFolded] = useState(false);
  const table = context.cards;
  const { revealedDeck, deckPlacement: placement } = state;
  const source = state.view?.choices.at(-1)?.context?.source ?? null;
  const prompt = placement !== null ? placementPrompt(placement, table) : choicePrompt(context);
  const picks = buttons.flatMap((button) => {
    const defId = answerCard(button.move, context);
    return defId === null ? [] : [{ defId, button }];
  });
  const others = buttons.filter((button) => answerCard(button.move, context) === null);
  // 山札を並べるときは、同じカードを 1 枚にまとめて枚数を添え、種類と名前で並べ直す。サーバの並びは見せた順で、
  // 探すときの手がかりにならない。
  const counts = new Map<string, number>();
  for (const defId of revealedDeck ?? []) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  const tiles: { defId: string; button: ListedMove | undefined }[] =
    revealedDeck === null
      ? picks
      : [
          ...[...counts.keys()]
            .sort(
              (a, b) =>
                kindRank(table[a]) - kindRank(table[b]) ||
                nameOf(table, a).localeCompare(nameOf(table, b), "ja"),
            )
            .map((defId) => ({
              defId,
              button: picks.find((pick) => pick.defId === defId)?.button,
            })),
          ...picks.filter(({ defId }) => !counts.has(defId)),
        ];
  // サーバは見せたあとに山札へ入ったカードを送らないので、並べた枚数が山札の枚数より少ないことがある。
  const deckCount = state.view?.self.deckCount;
  const heading =
    revealedDeck === null
      ? null
      : deckCount === undefined || deckCount === revealedDeck.length
        ? `山札 ${revealedDeck.length} 枚`
        : `山札 ${deckCount} 枚のうち、見た ${revealedDeck.length} 枚`;

  return (
    <section
      id="choice-sheet"
      className="choice-sheet"
      aria-label="カードを選ぶ"
      data-folded={folded ? "" : undefined}
    >
      <div className="choice-head">
        {source !== null && (
          <CardFace defId={source.defId} zoom={{ title: source.label, defIds: [source.defId] }} />
        )}
        <p id="move-prompt" className="move-prompt">
          {prompt}
        </p>
        <button id="choice-fold" className="secondary" onClick={() => setFolded(!folded)}>
          {folded ? "選ぶカードを出す" : "盤面を見る"}
        </button>
      </div>
      {!folded && (
        <div id="moves" className="choice-body">
          {heading !== null && <h3>{heading}</h3>}
          <div
            id={revealedDeck === null ? undefined : "revealed-deck"}
            className="choice-cards"
            data-count={revealedDeck?.length}
          >
            {tiles.map(({ defId, button }) => {
              const count = counts.get(defId);
              const shown = count === undefined ? null : <span>×{count}</span>;
              return button === undefined ? (
                <div key={defId} className="choice-card" data-count={count}>
                  <CardFace
                    defId={defId}
                    pickable={false}
                    zoom={{ title: "山札", defIds: [defId] }}
                  />
                  {shown}
                </div>
              ) : (
                <button
                  key={button.key}
                  className="choice-card"
                  data-count={count}
                  disabled={disabled}
                  aria-disabled={awaiting}
                  onClick={() => onPlay(button.move)}
                >
                  <CardFace defId={defId} pickable />
                  {shown}
                  <span className="choice-label">{button.label}</span>
                </button>
              );
            })}
          </div>
          {others.length > 0 && (
            <div className="moves">
              {others.map(({ move, key, label }) => (
                <button
                  key={key}
                  disabled={disabled}
                  aria-disabled={awaiting}
                  onClick={() => onPlay(move)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * 引き直すときに見せた手札を、見せた順に並べる。準備のあいだに増えたら開き、対戦が始まったら畳む。
 * 相手が引き直したことは、相手に番が回る前に起きるので、できごとの欄だけでは見落とす。
 * それ以外の局面では開け閉めしない。プレイヤーが開いた欄を、次の局面で閉じてしまう。
 */
function Mulligans({ state: { mulligans, view } }: { state: SeatState }) {
  const inSetup = view?.phase === "setup";
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState({ count: 0, inSetup: false });
  if (seen.count !== mulligans.length || seen.inSetup !== inSetup) {
    if (mulligans.length > seen.count && inSetup) setOpen(true);
    if (seen.inSetup && !inSetup) setOpen(false);
    setSeen({ count: mulligans.length, inSetup });
  }
  if (mulligans.length === 0) return null;
  const counts: Record<Player, number> = { 0: 0, 1: 0 };
  return (
    <details
      id="mulligans"
      className="mulligans"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>引き直しで見せた手札</summary>
      <div id="mulligan-list">
        {mulligans.map(({ player, cards }, index) => {
          counts[player] += 1;
          const own = player === view?.viewer;
          return (
            // oxlint-disable-next-line react/no-array-index-key -- 見せた順に足されるだけで、並びは変わらない。
            <div key={index} className="mulligan" data-side={own ? "self" : "opponent"}>
              {`${own ? "自分" : "相手"}（${counts[player]} 回目）`}
              <div className="zone hand">
                {cards.map((defId, at) => {
                  const zoom = { title: "見せた手札", defIds: [defId] };
                  return (
                    // oxlint-disable-next-line react/no-array-index-key -- 同じカードが何枚も並ぶので、位置のほかに見分けがない。
                    <CardFace key={at} defId={defId} zoom={zoom} />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
