import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountKey, accountQuery, storedSecret } from "../lib/account.js";
import { messageOf, post } from "../lib/api.js";
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
  // 読むだけで取りに行かない。席に着いているときに開き直しても、プレイヤーを作り直させない。
  const account = useQuery({ ...accountQuery(), enabled: false });
  const playerId = account.data?.playerId ?? null;
  // 一覧を頼んだことは、プレイヤーが替わっても覚えておく。一覧を取りに行く途中でプレイヤーを
  // 作ることがあり、そのときに押したぶんが消えないよう、作り直した側で取り直す。
  const [requested, setRequested] = useState(false);
  // サーバがプレイヤーを忘れて作り直したら、一覧も開いているリプレイも前のプレイヤーのもので、
  // 新しいシークレットでは読めない。プレイヤーごとに作り直す。
  return (
    <PlayerHistory
      key={playerId}
      playerId={playerId}
      requested={requested}
      onRequest={() => setRequested(true)}
    />
  );
}

/**
 * シークレットを添えて頼む。サーバがプレイヤーを忘れていたら、ロビーと同じく覚えているプレイヤーを
 * 古いものとし、次に一覧を出すときに作り直す。
 */
async function postAsPlayer<T>(
  queryClient: QueryClient,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await post(path, { ...body, secret: storedSecret() });
  const answer = (await response.json().catch(() => null)) as
    | (T & { code?: unknown; error?: unknown })
    | null;
  if (response.ok && answer !== null) return answer;
  if (answer?.code === "account-not-found") {
    void queryClient.invalidateQueries({ queryKey: accountKey, refetchType: "none" });
  }
  throw new Error(
    typeof answer?.error === "string" ? answer.error : `${path} が ${response.status} を返した`,
  );
}

function PlayerHistory({
  playerId,
  requested,
  onRequest,
}: {
  playerId: string | null;
  requested: boolean;
  onRequest: () => void;
}) {
  const queryClient = useQueryClient();
  const matches = useQuery({
    queryKey: ["matches", playerId],
    queryFn: async () => {
      // 初めて来た人はシークレットをまだ持たない。待たずに送ると、アカウントが見つからないと断られる。
      // 待つあいだにプレイヤーが替わったら、この部品ごと作り直され、作り直した側が取り直す。
      await queryClient.fetchQuery(accountQuery());
      const { matches: list } = await postAsPlayer<{ matches: MatchSummary[] }>(
        queryClient,
        "/api/matches",
        {},
      );
      return list;
    },
    // 頼まれるまでは取りに行かない。決着した対戦は、押し直せば一覧に加わる。
    enabled: requested,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [opened, setOpened] = useState<MatchSummary | null>(null);
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
            onRequest();
            // 取りに行っている途中なら、それを止めて取り直す。遅れて届いた古い一覧で新しい一覧を消さない。
            void matches.refetch();
          }}
        >
          一覧を出す
        </button>
        <p id="history-status" className="note">
          {failure ||
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
                setOpened(summary);
              }}
            >
              {describeSummary(summary)}
            </button>
          ))}
        </div>
      </section>
      {opened !== null && (
        <Replay
          // 別の対戦を開いたら、前の対戦の局面や問い合わせを持ち越さない。
          key={opened.matchId}
          summary={opened}
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
    // 端でさらに押しても、行き先は変わらない。同じ局面をサーバに作り直させない。
    if (clampPly(latest.current, target) === latest.current.wanted) return;
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
        {[frame === null ? "" : replayStatusText(frame, seat, table), failure]
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
