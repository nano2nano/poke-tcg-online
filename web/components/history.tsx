import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountQuery, storedSecret } from "../lib/account.js";
import { messageOf, postJson } from "../lib/api.js";
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
  /** 閉じてから開き直しても同じ数を配らないよう、減らさずに数える。 */
  const opens = useRef(0);
  const openKey = useRef<number | null>(null);
  const [failure, setFailure] = useState("");

  const open = (summary: MatchSummary) => {
    opens.current += 1;
    openKey.current = opens.current;
    setFailure("");
    setOpened({ summary, key: opens.current });
  };
  const close = () => {
    openKey.current = null;
    setOpened(null);
  };
  /** 開けないものを空の欄で見せない。閉じたものや、別のものに開き直したものの失敗は出さない。 */
  const failedToOpen = (key: number, error: unknown) => {
    if (openKey.current !== key) return;
    close();
    setFailure(`開けませんでした: ${messageOf(error)}`);
  };

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
          {failure ||
            (matches.isError ? `一覧を出せませんでした: ${messageOf(matches.error)}` : "")}
        </p>
        <div id="history-list" className="history-list">
          {matches.data?.length === 0 && "まだ読み返せる対戦がありません。"}
          {matches.data?.map((summary) => (
            <button key={summary.matchId} type="button" onClick={() => open(summary)}>
              {describeSummary(summary)}
            </button>
          ))}
        </div>
      </section>
      {opened !== null && (
        <Replay
          key={opened.key}
          summary={opened.summary}
          onClose={close}
          onOpenFailed={(error) => failedToOpen(opened.key, error)}
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

  // 開いたら最初の局面を取りに行く。開き直すと `key` が変わり、別の部品として取り直す。
  const openFirst = useEffectEvent(() => {
    goTo(0).catch(onOpenFailed);
  });
  useEffect(() => openFirst(), []);

  const step = (to: (state: ReplayState) => number) => () => {
    // 数えるのは頼んだ手数からである。描けた手数から数えると、続けて押したぶんが
    // すべて同じ 1 手への問い合わせになり、押しただけ進まない。
    goTo(to(latest.current)).catch((error: unknown) => {
      // 最初の局面より先に押したものが失敗したら、開けなかったのと同じで描くものが無い。
      if (latest.current.frame === null) onOpenFailed(error);
      else setFailure(`辿れませんでした: ${messageOf(error)}`);
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
        {failure || (frame === null ? "" : replayStatusText(frame, seat, table))}
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
