import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountQuery, storedSecret } from "../lib/account.js";
import { messageOf, postJson } from "../lib/api.js";
import { useCardData, type CardTable } from "../lib/cards.js";
import { readerView } from "../lib/describe.js";
import { describeMove } from "../lib/describe-move.js";
import { initialReplayState, replayReducer, type ReplayState } from "../lib/match-state.js";
import { SideBoard, Stadium } from "./board.js";

/**
 * 指した対戦の一覧と、開いた対戦のリプレイ。
 *
 * 横に広い画面では、対戦のあいだこの欄を CSS が隠す。卓と同じく `body` の直下に置く。
 */
export function History() {
  const queryClient = useQueryClient();
  const matches = useQuery({
    queryKey: ["matches"],
    queryFn: async () => {
      // 初めて来た人はシークレットをまだ持たない。待たずに送ると、アカウントが見つからないと断られる。
      await queryClient.fetchQuery(accountQuery());
      const { matches: list } = await postJson<{ matches: MatchSummary[] }>("/api/matches", {
        secret: storedSecret(),
      });
      return list;
    },
    // 押したときだけ取りに行く。決着した対戦は、押し直せば一覧に加わる。
    enabled: false,
    retry: false,
  });
  /** 開いているリプレイ。開くたびに数を進め、前に開いたものの続きを描かせない。 */
  const [opened, setOpened] = useState<{ summary: MatchSummary; key: number } | null>(null);
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
            // 取りに行っている途中なら、それを止めて取り直す。遅れて届いた古い一覧で新しい一覧を消さない。
            void matches.refetch();
          }}
        >
          一覧を出す
        </button>
        <p id="history-status" className="note">
          {matches.isError ? `一覧を出せませんでした: ${messageOf(matches.error)}` : failure}
        </p>
        <div id="history-list" className="history-list">
          {matches.data?.length === 0 && "まだ読み返せる対戦がありません。"}
          {matches.data?.map((summary) => (
            <button
              key={summary.matchId}
              type="button"
              onClick={() => {
                setFailure("");
                setOpened((previous) => ({ summary, key: (previous?.key ?? 0) + 1 }));
              }}
            >
              {describeSummary(summary)}
            </button>
          ))}
        </div>
      </section>
      {opened !== null && (
        <Replay
          key={opened.key}
          summary={opened.summary}
          onClose={() => setOpened(null)}
          onOpenFailed={(error) => {
            // 開けないものを空の欄で見せない。
            setOpened((current) => (current?.key === opened.key ? null : current));
            setFailure(`開けませんでした: ${messageOf(error)}`);
          }}
        />
      )}
    </>
  );
}

function describeSummary(summary: MatchSummary): string {
  const outcome = { win: "勝ち", loss: "負け", draw: "引き分け" }[summary.outcome];
  const how = { normal: "", concede: "（投了）", timeout: "（時間切れ）" }[
    summary.matchResult.kind
  ];
  const when = new Date(summary.endedAt).toLocaleString("ja-JP");
  return `${when} ${summary.opponentName} と ${outcome}${how} ${summary.moveCount} 手`;
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
      update(replayReducer(latest.current, { t: "failed", asked }));
      throw error;
    }
    const drawn = replayReducer(latest.current, { t: "frame", asked, frame });
    if (drawn === latest.current) return;
    update(drawn);
    setFailure("");
  };

  // 開いたら最初の局面を取りに行く。開き直すと `key` が変わり、別の部品として取り直す。
  const openFirst = useEffectEvent(() => {
    goTo(0).catch(onOpenFailed);
  });
  useEffect(() => openFirst(), []);

  const step = (to: (state: ReplayState) => number) => () => {
    // 数えるのは頼んだ手数からである。描けた手数から数えると、続けて押したぶんが
    // すべて同じ 1 手への問い合わせになり、押しただけ進まない。
    goTo(to(latest.current)).catch((error: unknown) => {
      setFailure(`辿れませんでした: ${messageOf(error)}`);
    });
  };

  const { frame, seat } = state;
  const board = frame === null ? null : readerView(frame.views, seat);
  return (
    <section id="replay">
      <h2>リプレイ</h2>
      <div className="replay-controls">
        <button id="replay-first" className="secondary" onClick={step(() => 0)}>
          さいしょ
        </button>
        <button id="replay-prev" className="secondary" onClick={step(({ wanted }) => wanted - 1)}>
          ◀ 1 手
        </button>
        <button id="replay-next" className="secondary" onClick={step(({ wanted }) => wanted + 1)}>
          1 手 ▶
        </button>
        <button id="replay-last" className="secondary" onClick={step(({ moveCount }) => moveCount)}>
          さいご
        </button>
        <button id="replay-close" className="secondary" onClick={onClose}>
          閉じる
        </button>
      </div>
      <p id="replay-status" className="note">
        {failure || (frame === null ? "" : frameText(frame, seat, table))}
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

function frameText(frame: ReplayFrame, seat: ReplayState["seat"], cards: CardTable): string {
  // 出したカードは指したあとの手札にもう無いので、名前は指す前の盤面から引く。
  const before = frame.beforeViews === null ? null : readerView(frame.beforeViews, seat);
  const move =
    frame.playedMove === null
      ? "対戦の開始時"
      : describeMove(frame.playedMove, { view: before, cards });
  // エンジンの版が違っても止めない。止めるのはカードの定義が変わったときだけである（仕様 6.3 節）。
  const warning = frame.engineCommitDiffers
    ? "　※ この対戦を指したときとエンジンの版が違います"
    : "";
  const diverged =
    frame.divergedAt === null
      ? ""
      : `　※ ${frame.divergedAt} 手目から先は、いまのエンジンでは再現できません`;
  return `${frame.ply} / ${frame.moveCount} 手　直前の手: ${move}${warning}${diverged}`;
}
