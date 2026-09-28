import { useEffect, useMemo, useRef, useState } from "react";
import type { Move, Player } from "../../src/engine.js";
import { useCardData } from "../lib/cards.js";
import { kindRank, nameOf, seatClockText } from "../lib/describe.js";
import {
  describeMove,
  foldMoves,
  handCardName,
  moveTargets,
  placementPrompt,
  setupPrompt,
  type MoveContext,
} from "../lib/describe-move.js";
import { setupOffer, type SeatState } from "../lib/match-state.js";
import { watchUrl, type StoredSeat } from "../lib/seat.js";
import { useSeat, type Seating } from "../lib/use-seat.js";
import { CardFace, NOTHING_AIMED, SideBoard, Stadium } from "./board.js";
import { EventLog } from "./event-log.js";
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
  onLeave: (reason: string) => void;
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
  // 一覧が変わったら、消えたボタンの狙いを捨てる。消えたボタンからはマウスが離れた知らせが来ないので、
  // 残すと、同じ手があとでまた並んだときに、載せていないのに囲む。残ったボタンの狙いはそのまま囲む。
  const [aimFor, setAimFor] = useState(listed);
  if (aimFor !== listed) {
    setAimFor(listed);
    const keys = new Set(listed.buttons.map(({ key }) => key));
    const kept = (key: string | null) => (key !== null && keys.has(key) ? key : null);
    setAim((current) => ({ hovered: kept(current.hovered), focused: kept(current.focused) }));
  }
  const disabled = connection !== null;
  const aimed = useMemo(() => {
    const targets = listed.buttons
      .filter(({ key }) => key === aim.hovered || key === aim.focused)
      .flatMap((button) => button.targets);
    // 空の集合を毎回作ると、盤面の memo が効かず、狙いの無いボタンに載せるたびに盤面を描き直す。
    return targets.length === 0 ? NOTHING_AIMED : new Set(targets);
  }, [listed, aim]);
  const onAim = (kind: keyof Aim, key: string | null) =>
    setAim((current) => (current[kind] === key ? current : { ...current, [kind]: key }));

  useEffect(() => {
    if (left !== null) onLeave(left);
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
        <div className="board">
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
              {view !== null && <SideBoard side={view.self} mirrored={false} aimed={aimed} />}
            </div>
          </div>
        </div>

        <div className="table-panel">
          <Mulligans state={state} />
          <h2>指せる手</h2>
          <Moves
            seating={seating}
            context={context}
            listed={listed}
            disabled={disabled}
            onAim={onAim}
          />
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

/** 対戦が終わっていれば、待ちも選ぶものも無い。 */
function Moves({
  seating: { state, awaiting, send, choose },
  context,
  listed,
  disabled,
  onAim,
}: {
  seating: Seating;
  context: MoveContext;
  listed: Listed;
  disabled: boolean;
  onAim: (kind: "hovered" | "focused", key: string | null) => void;
}) {
  const { view, legalMoves: moves, setup, deckPlacement: placement, revealedDeck } = state;
  const table = context.cards;
  const playing = state.ended === null;
  const prompt = !playing
    ? ""
    : moves !== null && placement !== null
      ? placementPrompt(placement, table)
      : setupPrompt(context, moves !== null, setup);

  const play = (move: Move) =>
    send({
      t: "move",
      stateVersion: state.stateVersion,
      move,
      ...(listed.offered === undefined ? {} : { offered: listed.offered }),
    });

  return (
    <>
      {prompt !== "" && (
        <p id="move-prompt" className="move-prompt">
          {prompt}
        </p>
      )}
      {playing && moves !== null && revealedDeck !== null && (
        <RevealedDeck state={state} table={table} moves={moves} revealedDeck={revealedDeck} />
      )}
      <SetupForm
        state={state}
        send={send}
        choose={choose}
        context={context}
        disabled={disabled}
        awaiting={awaiting}
      />
      <div id="moves" className="moves">
        {moves === null
          ? // 準備の待ちは `move-prompt` が伝える。「相手の番」と出すと、番が相手へ移ったと読まれる。
            playing && view !== null && view.phase !== "setup" && <WaitingNote state={state} />
          : listed.buttons.map(({ move, key, label }) => (
              <button
                key={key}
                disabled={disabled}
                // 返事を待つあいだは `disabled` にしない。押したボタンからフォーカスが外れる。
                aria-disabled={awaiting}
                onClick={() => {
                  if (!awaiting) play(move);
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

/**
 * 山札を見て選ぶ効果で、見ている山札を並べる。エンジンの候補は条件に合うカードだけなので、
 * ボタンだけでは、選べないカードや、山札に何が残っていて何がサイドに落ちたかを読めない。
 * 選ぶのはボタンで行い、選べるカードは枠で囲まない。囲むと、カードを押せば選べるように見える。
 */
function RevealedDeck({
  state,
  table,
  moves,
  revealedDeck,
}: {
  state: SeatState;
  table: MoveContext["cards"];
  moves: Move[];
  revealedDeck: string[];
}) {
  const pickable = new Set(
    moves.flatMap((move) =>
      move.type === "AnswerChoice" && move.answer.kind === "cardDef" ? [move.answer.defId] : [],
    ),
  );
  const counts = new Map<string, number>();
  for (const defId of revealedDeck) counts.set(defId, (counts.get(defId) ?? 0) + 1);
  // サーバの並びは見せた順で、探すときの手がかりにならないので、種類と名前で並べ直す。
  const defIds = [...counts.keys()].sort(
    (a, b) =>
      kindRank(table[a]) - kindRank(table[b]) ||
      nameOf(table, a).localeCompare(nameOf(table, b), "ja"),
  );
  // サーバは見せたあとに山札へ入ったカードを送らないので、並べた枚数が山札の枚数より少ないことがある。
  const deckCount = state.view?.self.deckCount;
  const heading =
    deckCount === undefined || deckCount === revealedDeck.length
      ? `山札 ${revealedDeck.length} 枚`
      : `山札 ${deckCount} 枚のうち、見た ${revealedDeck.length} 枚`;
  return (
    <div id="revealed-deck" className="revealed-deck" data-count={revealedDeck.length}>
      <h3>{heading}</h3>
      <div className="revealed-cards">
        {defIds.map((defId) => (
          <div key={defId} className="revealed-card" data-count={counts.get(defId)}>
            <CardFace defId={defId} pickable={pickable.has(defId)} />
            <span>×{counts.get(defId)}</span>
          </div>
        ))}
      </div>
    </div>
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
                {cards.map((defId, at) => (
                  // oxlint-disable-next-line react/no-array-index-key -- 同じカードが何枚も並ぶので、位置のほかに見分けがない。
                  <CardFace key={at} defId={defId} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
