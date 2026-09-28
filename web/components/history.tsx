import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountKey, accountQuery, postAsPlayer } from "../lib/account.js";
import { messageOf } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import { describeSummary, readerView } from "../lib/describe.js";
import { replayStatusText } from "../lib/describe-move.js";
import {
  clampPly,
  initialReplayState,
  replayReducer,
  type ReplayState,
} from "../lib/match-state.js";
import { SideBoard, Stadium } from "./board.js";

/**
 * 指した対戦の一覧と、開いた対戦のリプレイ。
 *
 * 横に広い画面では、対戦のあいだこの欄を CSS が隠す。卓と同じく `body` の直下に置く。
 */
export function History() {
  const queryClient = useQueryClient();
  // 一覧を頼んだことは、プレイヤーが替わっても覚えておく。プレイヤーを用意してから一覧を取るので、
  // 押したぶんは、用意したプレイヤーの側で取る。
  const [requested, setRequested] = useState(false);
  // 頼まれるまではプレイヤーを読みに行かない。席に着いたまま開き直したときに、作り直させない。
  const account = useQuery({ ...accountQuery(), enabled: requested });
  const playerId = account.data?.playerId ?? null;

  /** 一覧を頼む。プレイヤーが用意できていれば真。できていなければ先に用意し、一覧は用意した側で取る。 */
  const request = () => {
    setRequested(true);
    // 忘れられていたと分かったプレイヤーも、用意し直す。古いシークレットで頼んでも断られる。
    if (account.data !== undefined && !queryClient.getQueryState(accountKey)?.isInvalidated) {
      return true;
    }
    void account.refetch();
    return false;
  };

  // サーバがプレイヤーを忘れて作り直したら、一覧も開いているリプレイも前のプレイヤーのもので、
  // 新しいシークレットでは読めない。プレイヤーごとに作り直す。
  return (
    <PlayerHistory
      key={playerId}
      playerId={playerId}
      requested={requested}
      onRequest={request}
      accountFailure={
        account.isError && !account.isFetching
          ? `プレイヤーを用意できませんでした: ${messageOf(account.error)}`
          : ""
      }
    />
  );
}

function PlayerHistory({
  playerId,
  requested,
  onRequest,
  accountFailure,
}: {
  playerId: string | null;
  requested: boolean;
  onRequest: () => boolean;
  accountFailure: string;
}) {
  const queryClient = useQueryClient();
  const matches = useQuery({
    queryKey: ["matches", playerId],
    queryFn: async () => {
      const { matches: list } = await postAsPlayer<{ matches: MatchSummary[] }>(
        queryClient,
        "/api/matches",
        {},
      );
      return list;
    },
    // 頼まれて、プレイヤーを用意できてから取りに行く。決着した対戦は、押し直せば一覧に加わる。
    enabled: requested && playerId !== null,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  /** 開いているリプレイ。押すたびに `serial` を進め、同じ対戦でも作り直して頼み直す。 */
  const [opened, setOpened] = useState<{ summary: MatchSummary; serial: number } | null>(null);
  const [failure, setFailure] = useState("");

  return (
    <>
      <section id="history">
        <h2>指した対戦を読み返す</h2>
        <p className="note">
          済んだ対戦を 1 手ずつ辿れます。終わった対戦なので、両方の手札まで見えます。
          読めるのは自分が指した対戦だけです。
        </p>
        <button
          id="history-button"
          className="secondary"
          onClick={() => {
            setFailure("");
            // 一覧を持っていて取り直している途中なら、それを止めて取り直す。遅れて届いた古い一覧で
            // 新しい一覧を消さない。まだ持っていなければ、取りに行っている途中の答えを待つ。
            if (onRequest()) void matches.refetch();
          }}
        >
          一覧を出す
        </button>
        <p id="history-status" className="note">
          {failure ||
            accountFailure ||
            (matches.isError && !matches.isFetching
              ? `一覧を出せませんでした: ${messageOf(matches.error)}`
              : "")}
        </p>
        <div id="history-list" className="history-list">
          {matches.data?.length === 0 && "まだ読み返せる対戦がありません。"}
          {matches.data?.map((summary) => (
            <button
              key={summary.matchId}
              type="button"
              onClick={() => {
                setFailure("");
                // 最初の局面が返ってこないときも、同じ行を押し直せば開き直せる。
                setOpened((previous) => ({ summary, serial: (previous?.serial ?? 0) + 1 }));
              }}
            >
              {describeSummary(summary)}
            </button>
          ))}
        </div>
      </section>
      {opened !== null && (
        <Replay
          // 開き直したら、前の局面や問い合わせを持ち越さない。
          key={opened.serial}
          summary={opened.summary}
          onClose={() => setOpened(null)}
          onOpenFailed={(error) => {
            // 開けないものを空の欄で見せない。
            setOpened(null);
            setFailure(`開けませんでした: ${messageOf(error)}`);
          }}
        />
      )}
    </>
  );
}

/**
 * 1 局のリプレイ。局面は持たず、手数ごとにサーバが作り直したものを取りに行く。
 * あとから出した問い合わせに追い越された応答では描かない（`replayReducer`）。
 */
function Replay({
  summary,
  onClose,
  onOpenFailed,
}: {
  summary: MatchSummary;
  onClose: () => void;
  onOpenFailed: (error: unknown) => void;
}) {
  const { table } = useCardData();
  const queryClient = useQueryClient();
  const [state, setState] = useState(() => initialReplayState(summary));
  /** 問い合わせの番号を、描き直しを待たずに進める。続けて押したぶんを、それぞれ別の手数として頼む。 */
  const latest = useRef<ReplayState>(state);
  const [failure, setFailure] = useState("");
  /**
   * 再現できない地点。サーバはその先を頼まれたときにしか知らせないので、分かったら覚えておく。
   * 手前へ戻ると知らせが消え、辿れる上限だけが下がったまま、進めない理由が見えなくなる。
   */
  const [divergedAt, setDivergedAt] = useState<number | null>(null);

  const update = (next: ReplayState) => {
    latest.current = next;
    setState(next);
  };

  const goTo = async (ply: number) => {
    const asking = replayReducer(latest.current, { t: "ask", ply });
    update(asking);
    const { asked, wanted, matchId } = asking;
    let frame: ReplayFrame;
    try {
      ({ frame } = await postAsPlayer<{ frame: ReplayFrame }>(queryClient, "/api/replay", {
        matchId,
        ply: wanted,
      }));
    } catch (error) {
      // あとから頼んだものがあれば、この失敗はもう画面に関わらない。
      if (latest.current.asked !== asked) return;
      update(replayReducer(latest.current, { t: "failed", asked }));
      throw error;
    }
    if (frame.divergedAt !== null) setDivergedAt(frame.divergedAt);
    const drawn = replayReducer(latest.current, { t: "frame", asked, frame });
    if (drawn === latest.current) return;
    update(drawn);
    setFailure("");
  };

  // 開いたら最初の局面を取りに行く。閉じたあとや別の対戦に開き直したあとに届いた失敗では、
  // いま開いているものを閉じない。
  const openFirst = useEffectEvent((closed: () => boolean) => {
    goTo(0).catch((error: unknown) => {
      if (!closed()) onOpenFailed(error);
    });
  });
  useEffect(() => {
    let closed = false;
    openFirst(() => closed);
    return () => {
      closed = true;
    };
  }, []);

  const step = (to: (state: ReplayState) => number) => () => {
    const target = to(latest.current);
    // 描けている局面をまた頼んでも、サーバに同じ局面を作り直させるだけになる。答えを待っている
    // あいだは頼む。返ってこない問い合わせを、押し直して頼み直せるようにする。
    const { ply, wanted } = latest.current;
    if (clampPly(latest.current, target) === ply && wanted === ply) return;
    // 数えるのは頼んだ手数からである。描けた手数から数えると、続けて押したぶんが
    // すべて同じ 1 手への問い合わせになり、押しただけ進まない。
    goTo(target).catch((error: unknown) => {
      setFailure(`辿れませんでした: ${messageOf(error)}`);
    });
  };

  const { frame, seat } = state;
  const board = frame === null ? null : readerView(frame.views, seat);
  // 最初の局面が描けるまでは辿らせない。先に押したものが追い越すと、開けたかどうかが決まらない。
  const waiting = frame === null;
  return (
    <section id="replay">
      <h2>リプレイ</h2>
      <div className="replay-controls">
        <button id="replay-first" className="secondary" disabled={waiting} onClick={step(() => 0)}>
          さいしょ
        </button>
        <button
          id="replay-prev"
          className="secondary"
          disabled={waiting}
          onClick={step(({ wanted }) => wanted - 1)}
        >
          ◀ 1 手
        </button>
        <button
          id="replay-next"
          className="secondary"
          disabled={waiting}
          onClick={step(({ wanted }) => wanted + 1)}
        >
          1 手 ▶
        </button>
        <button
          id="replay-last"
          className="secondary"
          disabled={waiting}
          onClick={step(({ moveCount }) => moveCount)}
        >
          さいご
        </button>
        <button id="replay-close" className="secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p id="replay-status" className="note">
        {[frame === null ? "" : replayStatusText(frame, seat, table, divergedAt), failure]
          .filter((line) => line !== "")
          .join("　")}
      </p>
      <div className="board">
        <div className="board-side">
          <h2>相手</h2>
          <div id="replay-opponent">
            {board !== null && <SideBoard side={board.opponent} mirrored />}
          </div>
        </div>
        <div id="replay-stadium" className="board-center">
          {board !== null && <Stadium stadium={board.stadium} />}
        </div>
        <div className="board-side">
          <h2>自分</h2>
          <div id="replay-self">
            {board !== null && <SideBoard side={board.self} mirrored={false} />}
          </div>
        </div>
      </div>
    </section>
  );
}
