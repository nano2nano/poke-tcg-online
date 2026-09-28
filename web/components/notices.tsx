/**
 * コイントスやダメージなどの結果を、画面の上の端に少しのあいだ重ねて出す。
 * ダメージと回復の数字は、そのポケモンの上に浮かべる。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { CoinToss, Hit, Notice, Tone } from "../lib/describe.js";

/**
 * 同時に出しておく結果の数。溢れたら古いものから消すが、コインは残す。1 つの手でもコイン、
 * ダメージ、特殊状態、きぜつ、番の交代と重なりうるので、古い順だとコインから先に消える。
 */
const NOTICE_LIMIT = 5;
const NOTICE_MS = 4_000;
/** コインは回り終えてから読むので、そのぶん長く残す。 */
const COIN_NOTICE_MS = 6_000;

interface Shown {
  id: number;
  text: string;
  tone: Tone;
  coins?: CoinToss;
}

interface Floating extends Hit {
  id: number;
}

export interface NoticeFeed {
  notices: Shown[];
  hits: Floating[];
  /** `hit` を持つ結果は、次に描いた盤面の上に数字を浮かべる。 */
  show: (notice: Notice) => void;
}

export function useNotices(): NoticeFeed {
  const [notices, setNotices] = useState<Shown[]>([]);
  const [hits, setHits] = useState<Floating[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const later = useCallback((ms: number, task: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      task();
    }, ms);
    timers.current.add(timer);
  }, []);

  const show = useCallback(
    ({ text, tone = "neutral", coins, hit }: Notice) => {
      const id = (nextId.current += 1);
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
        setHits((current) => [...current, { ...hit, id }]);
        later(NOTICE_MS, () =>
          setHits((current) => current.filter((floating) => floating.id !== id)),
        );
      }
    },
    [later],
  );

  return { notices, hits, show };
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
 * 置き場所は、結果と同じ局面で描いた盤面から測る。前の盤面のポケモンは、入れ替えやきぜつで
 * 別の場所にいることがある。ポケモンがもう盤面にいなければ出さない。
 */
function FloatingHit({ hit, board }: { hit: Floating; board: RefObject<HTMLElement | null> }) {
  const self = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const span = self.current;
    if (span === null) return;
    const pokemon = board.current?.querySelector(
      `.pokemon[data-in-play-id="${CSS.escape(hit.target)}"]`,
    );
    if (pokemon == null) {
      span.hidden = true;
      return;
    }
    const rect = pokemon.getBoundingClientRect();
    span.style.left = `${rect.left + rect.width / 2}px`;
    span.style.top = `${rect.top + rect.height / 3}px`;
  }, [hit, board]);
  return (
    <span ref={self} className="hit" data-tone={hit.tone} aria-hidden="true">
      {hit.text}
    </span>
  );
}
