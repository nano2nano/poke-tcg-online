import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountKey, accountQuery, storedSecret } from "../lib/account.js";
import { messageOf, post, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import { describeSummary, readerView } from "../lib/describe.js";
import { replayStatusText } from "../lib/describe-move.js";
import { initialReplayState, replayReducer, type ReplayState } from "../lib/match-state.js";
import { SideBoard, Stadium } from "./board.js";

/**
 * 指した対戦の一覧と、開いた対戦のリプレイ。
 *
 * 横に広い画面では、対戦のあいだこの欄を CSS が隠す。卓と同じく `body` の直下に置く。
 */
export function History() {
  const account = useQuery(accountQuery());
  const playerId = account.data?.playerId ?? null;
  // サーバがプレイヤーを忘れて作り直したら、一覧も開いているリプレイも前のプレイヤーのもので、
  // 新しいシークレットでは読めない。プレイヤーごとに作り直す。
  return (
    <PlayerHistory
      key={playerId}
      playerId={playerId}
      // プレイヤーを読み終えるまでは押させない。読み終えると作り直すので、それまでに出した一覧は消える。
      loadingAccount={account.isPending && account.isFetching}
    />
  );
}

function PlayerHistory({
  playerId,
  loadingAccount,
}: {
  playerId: string | null;
  loadingAccount: boolean;
}) {
  const queryClient = useQueryClient();
  const matches = useQuery({
    queryKey: ["matches", playerId],
    queryFn: async () => {
      // 初めて来た人はシークレットをまだ持たない。待たずに送ると、アカウントが見つからないと断られる。
      // 待つあいだにプレイヤーが替わったら、この部品ごと作り直されるので、返すものは使われない。
      await queryClient.fetchQuery(accountQuery());
      const response = await post("/api/matches", { secret: storedSecret() });
      const answer = (await response.json().catch(() => null)) as {
        matches?: MatchSummary[];
        code?: unknown;
        error?: unknown;
      } | null;
      if (response.ok && answer?.matches !== undefined) return answer.matches;
      // ロビーと同じく、覚えているプレイヤーを古いものとし、次に押したときに作り直す。
      if (answer?.code === "account-not-found") {
        void queryClient.invalidateQueries({ queryKey: accountKey, refetchType: "none" });
      }
      throw new Error(
        typeof answer?.error === "string"
          ? answer.error
          : `/api/matches が ${response.status} を返した`,
      );
    },
    // 押したときだけ取りに行く。決着した対戦は、押し直せば一覧に加わる。
    enabled: false,
    retry: false,
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
          disabled={loadingAccount}
          onClick={() => {
            setFailure("");
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
      ({ frame } = await postJson<{ frame: ReplayFrame }>("/api/replay", {
        secret: storedSecret(),
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
    if (replayReducer(latest.current, { t: "ask", ply: target }).wanted === latest.current.wanted) {
      return;
    }
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
