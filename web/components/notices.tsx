/**
 * 結果を盤面の上で見せる演出。ダメージと回復の数字は、そのポケモンの上に浮かべる。出たカードと
 * コインは、盤面の左の端に大きく見せる。結果の文は対戦ログ（`event-log.tsx`）に出す。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { CoinToss, Hit, Notice } from "../lib/describe.js";
import { SETTLE_MS } from "../lib/motion.js";
import { CardFace } from "./board.js";
import { useMotionOn } from "./motion-setting.js";

const HIT_MS = 4_000;
/** 1 つの局面の結果を、この間を置いて 1 つずつ出す。 */
const STEP_MS = 400;
/**
 * コインの結果の次は、コインが回り終えてから出す。回っているあいだに次の結果を重ねない。
 * 回る長さと 1 枚ずつずらす間は、`styles.css` の `.coin-inner` と揃える。
 */
const COIN_SPIN_MS = 1_000;
const COIN_GAP_MS = 150;
/** 出たカードと、回り終えたコインを大きく見せておく長さ。 */
const SHOWCASE_MS = 1_500;

interface Floating extends Hit {
  id: number;
}

interface Shown<T> {
  id: number;
  value: T;
}

export interface NoticeFeed {
  hits: Floating[];
  /**
   * 大きく見せている、出たカードの defId とコイン。コインのあとにカードが出ても読み終える前に消さないよう、
   * 枠を分けておき、それぞれ次のものが来たら入れ替える。
   */
  card: Shown<string> | null;
  coins: Shown<CoinToss> | null;
  /**
   * 同じタスクの中で続けて渡した結果は、1 つの局面の結果として順に出す。次の局面の結果が来たら、
   * 出しきっていない前の結果は待たせずに出す。`hit` を持つ結果は、盤面の上に数字を浮かべる。
   */
  show: (notice: Notice) => void;
  /**
   * 渡した結果を出し終え、出たカードとコインを見せ終え、カードが動き終えるまでの長さ。演出を出さないなら 0。
   * 新しい局面を受けた直後に呼ぶ。結果の無い局面でも、カードが動き終えるまでは待つ。
   */
  remainingMs: () => number;
}

export function useNotices(): NoticeFeed {
  const [hits, setHits] = useState<Floating[]>([]);
  const [card, setCard] = useState<Shown<string> | null>(null);
  const [coins, setCoins] = useState<Shown<CoinToss> | null>(null);
  const [queue] = useState(() => createQueue(setHits, setCard, setCoins));
  useEffect(() => queue.dispose, [queue]);
  // 演出を出さないときはカードを動かさないので、結果も数字も待たせずに出す。
  const animate = useMotionOn();
  useEffect(() => queue.setAnimate(animate), [queue, animate]);
  return { hits, card, coins, show: queue.show, remainingMs: queue.remainingMs };
}

type Setter<T> = (update: (current: T) => T) => void;

function createQueue(
  setHits: Setter<Floating[]>,
  setCard: Setter<Shown<string> | null>,
  setCoins: Setter<Shown<CoinToss> | null>,
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
      later(HIT_MS, () => setHits((current) => current.filter((hit) => hit.id !== id)));
    }
  };
  const schedule = () => {
    if (settling.length === 0 || floating !== undefined) return;
    const wait = settledAt - performance.now();
    if (wait <= 0) float();
    else floating = later(wait, float);
  };

  const present = <T,>(set: Setter<Shown<T> | null>, id: number, value: T, ms: number) => {
    set(() => ({ id, value }));
    later(ms, () => set((current) => (current?.id === id ? null : current)));
  };

  const reveal = ({ coins, hit, card }: Notice) => {
    const id = (nextId += 1);
    if (hit !== undefined) {
      settling.push({ ...hit, id });
      schedule();
    }
    if (card !== undefined) present(setCard, id, card, SHOWCASE_MS);
    if (coins !== undefined) present(setCoins, id, coins, showcaseOf(coins));
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
      // 文だけの結果は対戦ログに出るので、盤面には出すものが無い。間を置くと、次の演出を遅らせるだけになる。
      if (notice.coins === undefined && notice.hit === undefined && notice.card === undefined)
        return;
      const revealAt = Math.max(performance.now(), doneAt);
      doneAt = revealAt + stepOf(notice.coins);
      busyUntil = Math.max(
        busyUntil,
        doneAt,
        notice.card === undefined ? 0 : revealAt + SHOWCASE_MS,
        notice.coins === undefined ? 0 : revealAt + showcaseOf(notice.coins),
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
    /** 出している演出を消す時計も止めるので、演出も消す。effect をやり直すと、同じ列をまた使う。 */
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      stepping = undefined;
      floating = undefined;
      waiting = [];
      settling = [];
      setHits(() => []);
      setCard(() => null);
      setCoins(() => null);
    },
  };
}

/** 結果を 1 つ出してから次を出すまでの間。 */
function stepOf(coins: CoinToss | undefined): number {
  return coins === undefined ? STEP_MS : COIN_SPIN_MS + COIN_GAP_MS * (coins.results.length - 1);
}

/** コインは回り終えてから読むので、回るあいだのぶん長く見せる。 */
function showcaseOf(coins: CoinToss): number {
  return stepOf(coins) + SHOWCASE_MS;
}

/** `board` は数字を浮かべる先のポケモンを探す範囲。同じ画面に盤面が 2 つあっても取り違えない。 */
export function NoticeLayer({
  feed,
  board,
}: {
  feed: NoticeFeed;
  board: RefObject<HTMLElement | null>;
}) {
  const { card, coins } = feed;
  return (
    <>
      {feed.hits.map((hit) => (
        <FloatingHit key={hit.id} hit={hit} board={board} />
      ))}
      {/* 読み上げには対戦ログの文が同じことを言う。 */}
      {(card !== null || coins !== null) && (
        <div className="showcase" aria-hidden="true">
          {card !== null && <CardFace key={card.id} defId={card.value} />}
          {coins !== null && <Coins key={coins.id} {...coins.value} />}
        </div>
      )}
    </>
  );
}

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
