/**
 * コイントスやダメージなどの結果を、画面の上の端に少しのあいだ重ねて出す。
 * ダメージと回復の数字は、そのポケモンの上に浮かべる。出たカードは、盤面の左の端に大きく見せる。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { CoinToss, Hit, Notice, Tone } from "../lib/describe.js";
import { SETTLE_MS } from "../lib/motion.js";
import { CardFace } from "./board.js";
import { useMotionOn } from "./motion-setting.js";

/**
 * 同時に出しておく結果の数。溢れたら古いものから消すが、コインは残す。1 つの手でもコイン、
 * ダメージ、特殊状態、きぜつ、番の交代と重なりうるので、古い順だとコインから先に消える。
 */
const NOTICE_LIMIT = 5;
const NOTICE_MS = 4_000;
/** コインは回り終えてから読むので、そのぶん長く残す。 */
const COIN_NOTICE_MS = 6_000;
/** 1 つの局面の結果を、この間を置いて 1 つずつ出す。 */
const STEP_MS = 400;
/**
 * コインの結果の次は、コインが回り終えてから出す。回っているあいだに次の結果を重ねない。
 * 回る長さと 1 枚ずつずらす間は、`styles.css` の `.coin-inner` と揃える。
 */
const COIN_SPIN_MS = 1_000;
const COIN_GAP_MS = 150;
/** 出たカードを大きく見せておく長さ。次のカードが出たら入れ替える。 */
const SHOWCASE_MS = 1_500;

interface Shown {
  id: number;
  text: string;
  tone: Tone;
  coins?: CoinToss;
}

interface Floating extends Hit {
  id: number;
}

interface Showcase {
  id: number;
  defId: string;
}

export interface NoticeFeed {
  notices: Shown[];
  hits: Floating[];
  showcase: Showcase | null;
  /**
   * 同じタスクの中で続けて渡した結果は、1 つの局面の結果として順に出す。次の局面の結果が来たら、
   * 出しきっていない前の結果は待たせずに出す。`hit` を持つ結果は、盤面の上に数字を浮かべる。
   */
  show: (notice: Notice) => void;
  /**
   * 渡した結果を出し終え、出たカードを見せ終え、カードが動き終えるまでの長さ。演出を出さないなら 0。
   * 新しい局面を受けた直後に呼ぶ。結果の無い局面でも、カードが動き終えるまでは待つ。
   */
  remainingMs: () => number;
}

export function useNotices(): NoticeFeed {
  const [notices, setNotices] = useState<Shown[]>([]);
  const [hits, setHits] = useState<Floating[]>([]);
  const [showcase, setShowcase] = useState<Showcase | null>(null);
  const [queue] = useState(() => createQueue(setNotices, setHits, setShowcase));
  useEffect(() => queue.dispose, [queue]);
  // 演出を出さないときはカードを動かさないので、結果も数字も待たせずに出す。
  const animate = useMotionOn();
  useEffect(() => queue.setAnimate(animate), [queue, animate]);
  return { notices, hits, showcase, show: queue.show, remainingMs: queue.remainingMs };
}

type Setter<T> = (update: (current: T[]) => T[]) => void;

function createQueue(
  setNotices: Setter<Shown>,
  setHits: Setter<Floating>,
  setShowcase: (update: (current: Showcase | null) => Showcase | null) => void,
) {
  let nextId = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** まだ出していない結果。 */
  let waiting: Notice[] = [];
  let stepping: ReturnType<typeof setTimeout> | undefined;
  /** 文は出したが、カードが動き終えるのを待っている数字。 */
  let settling: Floating[] = [];
  let floating: ReturnType<typeof setTimeout> | undefined;
  let settledAt = 0;
  /** 待っている結果を出し終える時刻。 */
  let doneAt = 0;
  /** `doneAt` に、出たカードを見せ終える時刻も合わせたもの。 */
  let busyUntil = 0;
  let inBatch = false;
  let animate = true;

  const later = (ms: number, task: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      task();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(timer);
  };

  const float = () => {
    cancel(floating);
    floating = undefined;
    const ready = settling;
    settling = [];
    setHits((current) => [...current, ...ready]);
    for (const { id } of ready) {
      later(NOTICE_MS, () => setHits((current) => current.filter((hit) => hit.id !== id)));
    }
  };
  const schedule = () => {
    if (settling.length === 0 || floating !== undefined) return;
    const wait = settledAt - performance.now();
    if (wait <= 0) float();
    else floating = later(wait, float);
  };

  const reveal = ({ text, tone = "neutral", coins, hit, card }: Notice) => {
    const id = (nextId += 1);
    const shown: Shown = coins === undefined ? { id, text, tone } : { id, text, tone, coins };
    setNotices((current) => {
      const next = [...current, shown];
      while (next.length > NOTICE_LIMIT) {
        const older = next.filter((notice) => notice !== shown);
        const drop = older.find((notice) => notice.coins === undefined) ?? older[0]!;
        next.splice(next.indexOf(drop), 1);
      }
      return next;
    });
    later(coins === undefined ? NOTICE_MS : COIN_NOTICE_MS, () =>
      setNotices((current) => current.filter((notice) => notice.id !== id)),
    );
    if (hit !== undefined) {
      settling.push({ ...hit, id });
      schedule();
    }
    if (card !== undefined) {
      setShowcase(() => ({ id, defId: card }));
      later(SHOWCASE_MS, () => setShowcase((current) => (current?.id === id ? null : current)));
    }
    return stepOf(coins);
  };

  const step = () => {
    const next = waiting.shift();
    if (next === undefined) {
      stepping = undefined;
      return;
    }
    stepping = later(reveal(next), step);
  };

  const flush = () => {
    cancel(stepping);
    stepping = undefined;
    const rest = waiting;
    waiting = [];
    for (const notice of rest) reveal(notice);
  };

  const skip = () => {
    settledAt = 0;
    flush();
    float();
  };

  return {
    show: (notice: Notice) => {
      if (!inBatch) {
        // 新しい局面が届いた。前の局面の結果の残りはすぐ出し、数字は新しい局面のカードが
        // 動き終えるまで待たせる。
        inBatch = true;
        queueMicrotask(() => (inBatch = false));
        settledAt = animate ? performance.now() + SETTLE_MS : 0;
        cancel(floating);
        floating = undefined;
        flush();
        schedule();
        doneAt = busyUntil = performance.now();
      }
      const revealAt = Math.max(performance.now(), doneAt);
      doneAt = revealAt + stepOf(notice.coins);
      busyUntil = Math.max(
        busyUntil,
        doneAt,
        notice.card === undefined ? 0 : revealAt + SHOWCASE_MS,
      );
      waiting.push(notice);
      if (!animate) flush();
      else if (stepping === undefined) step();
    },
    remainingMs: () => (animate ? Math.max(SETTLE_MS, busyUntil - performance.now()) : 0),
    /** 演出を切ったら、待たせている結果と数字もすぐ出す。 */
    setAnimate: (next: boolean) => {
      animate = next;
      if (!next) skip();
    },
    /** 出している結果を消す時計も止めるので、結果も消す。effect をやり直すと、同じ列をまた使う。 */
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stepping = undefined;
      floating = undefined;
      waiting = [];
      settling = [];
      setNotices(() => []);
      setHits(() => []);
      setShowcase(() => null);
    },
  };
}

/** 結果を 1 つ出してから次を出すまでの間。 */
function stepOf(coins: CoinToss | undefined): number {
  return coins === undefined ? STEP_MS : COIN_SPIN_MS + COIN_GAP_MS * (coins.results.length - 1);
}

/** `board` は数字を浮かべる先のポケモンを探す範囲。同じ画面に盤面が 2 つあっても取り違えない。 */
export function NoticeLayer({
  feed,
  board,
}: {
  feed: NoticeFeed;
  board: RefObject<HTMLElement | null>;
}) {
  return (
    <>
      <output id="results" className="results">
        {feed.notices.map((notice) => (
          <div key={notice.id} className="result" data-tone={notice.tone}>
            {notice.coins !== undefined && <Coins {...notice.coins} />}
            <p className="result-text">{notice.text}</p>
          </div>
        ))}
      </output>
      {/* 結果の枠は transform で中央へ寄せている。中に置くと、画面ではなく枠が位置の基準になる。 */}
      {feed.hits.map((hit) => (
        <FloatingHit key={hit.id} hit={hit} board={board} />
      ))}
      {/* 読み上げには結果の文が同じことを言う。 */}
      {feed.showcase !== null && (
        <div key={feed.showcase.id} className="showcase" aria-hidden="true">
          <CardFace defId={feed.showcase.defId} />
        </div>
      )}
    </>
  );
}

/** 読み上げには結果の文が同じことを言うので、コインの絵は読ませない。 */
function Coins({ results, faces }: CoinToss) {
  return (
    <div className="coins" aria-hidden="true">
      {results.map((heads, index) => (
        <span
          // oxlint-disable-next-line react/no-array-index-key -- 1 回の結果の並びは変わらず、何枚目かがそのまま名前になる。
          key={index}
          className="coin"
          data-face={heads ? "heads" : "tails"}
          style={{ "--order": String(index) } as CSSProperties}
        >
          <span className="coin-inner">
            <span className="coin-face heads">{faces[0]}</span>
            <span className="coin-face tails">{faces[1]}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * 置き場所は、数字を浮かべるときに描いている盤面から測る。前の盤面のポケモンは、入れ替えやきぜつで
 * 別の場所にいることがある。ポケモンがもう盤面にいなければ出さない。ポケモンが動いている途中なら、
 * 動き終えてから測る。
 */
function FloatingHit({ hit, board }: { hit: Floating; board: RefObject<HTMLElement | null> }) {
  const self = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const span = self.current;
    const area = board.current;
    if (span === null || area === null) return;
    /** 置けたか、置く先がもう無ければ true を返す。 */
    const place = () => {
      const pokemon = area.querySelector(`.pokemon[data-in-play-id="${CSS.escape(hit.target)}"]`);
      span.hidden = true;
      if (pokemon === null) return true;
      if (pokemon.hasAttribute("data-moving")) return false;
      const rect = pokemon.getBoundingClientRect();
      span.style.left = `${rect.left + rect.width / 2}px`;
      span.style.top = `${rect.top + rect.height / 3}px`;
      span.hidden = false;
      return true;
    };
    if (place()) return;
    // 待つあいだに、次の局面でポケモンが別の要素に描き直されることもある。盤面ごと見て探し直す。
    const observer = new MutationObserver(() => {
      if (place()) observer.disconnect();
    });
    observer.observe(area, { subtree: true, childList: true, attributeFilter: ["data-moving"] });
    return () => observer.disconnect();
  }, [hit, board]);
  return (
    <span ref={self} className="hit" data-tone={hit.tone} aria-hidden="true">
      {hit.text}
    </span>
  );
}
