import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { MatchSummary } from "../../src/archive.js";
import type { ReplayFrame } from "../../src/history.js";
import { accountQuery, postAsPlayer } from "../lib/account.js";
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
import { Board, SideBoard, Stadium } from "./board.js";
import { SettingsButton } from "./settings.js";

/** 指した対戦の一覧と、開いた対戦のリプレイ。 */
export function History() {
  const account = useQuery(accountQuery());
  const playerId = account.data?.playerId ?? null;
  // サーバがプレイヤーを忘れて作り直したら、一覧も開いているリプレイも前のプレイヤーのもので、
  // 新しいシークレットでは読めない。プレイヤーごとに作り直す。
  return (
    <PlayerHistory
      key={playerId}
      playerId={playerId}
      accountFailure={account.isError ? messageOf(account.error) : ""}
    />
  );
}

function PlayerHistory({
  playerId,
  accountFailure,
}: {
  playerId: string | null;
  accountFailure: string;
}) {
  const queryClient = useQueryClient();
  const matches = useQuery({
    queryKey: ["matches", playerId],
    queryFn: async () => {
      // 忘れられていたと分かったプレイヤーは、ここで用意し直す。用意している途中なら、それを待つ。
      // 重ねて用意すると 2 人できる。
      const account = await queryClient.fetchQuery(accountQuery());
      // 替わったなら、この部品は作り直され、作り直した側が取り直す。ここで返すものは誰も読まない。
      if (account.playerId !== playerId) return [];
      const { matches: list } = await postAsPlayer<{ matches: MatchSummary[] }>(
        queryClient,
        "/api/matches",
        {},
      );
      return list;
    },
    // プレイヤーを用意できてから取りに行く。開くたびに取り直すので、決着した対戦が一覧に加わる。
    enabled: playerId !== null,
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
        <header className="page-head">
          <div>
            <h1>対戦の記録</h1>
            <p className="note">
              指した対戦を 1 手ずつ辿れます。終わった対戦なので、両方の手札まで見えます。
            </p>
          </div>
          <button
            id="history-button"
            onClick={() => {
              setFailure("");
              // 一覧を持っていて取り直している途中なら、それを止めて取り直す。遅れて届いた古い一覧で
              // 新しい一覧を消さない。まだ持っていなければ、取りに行っている途中の答えを待つ。
              // プレイヤーを用意できなかったときも押せる。一覧を頼む前に用意し直す。
              void matches.refetch();
            }}
          >
            読み直す
          </button>
        </header>
        <output id="history-status" className="status ng">
          {failure ||
            (matches.isError && !matches.isFetching
              ? `一覧を出せませんでした: ${messageOf(matches.error)}`
              : accountFailure && `プレイヤーを用意できませんでした: ${accountFailure}`)}
        </output>
        <div id="history-list" className="history-list">
          {matches.data?.length === 0 && (
            <p className="empty-state">まだ読み返せる対戦がありません。</p>
          )}
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
    const drawn = replayReducer(latest.current, { t: "frame", asked, frame });
    if (drawn === latest.current) return;
    update(drawn);
    // 辿れる上限を下げたのと同じ局面で覚える。追い越された局面で覚えると、上限と食い違う。
    if (frame.divergedAt !== null) setDivergedAt(frame.divergedAt);
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
        <button id="replay-first" disabled={waiting} onClick={step(() => 0)}>
          さいしょ
        </button>
        <button id="replay-prev" disabled={waiting} onClick={step(({ wanted }) => wanted - 1)}>
          ◀ 1 手
        </button>
        <button id="replay-next" disabled={waiting} onClick={step(({ wanted }) => wanted + 1)}>
          1 手 ▶
        </button>
        <button id="replay-last" disabled={waiting} onClick={step(({ moveCount }) => moveCount)}>
          さいご
        </button>
        <button id="replay-close" onClick={onClose}>
          閉じる
        </button>
        <SettingsButton id="replay-settings-button" />
      </div>
      <p id="replay-status" className="note">
        {[frame === null ? "" : replayStatusText(frame, seat, table, divergedAt), failure]
          .filter((line) => line !== "")
          .join("　")}
      </p>
      <Board
        name="replay"
        near={board?.self ?? null}
        far={board?.opponent ?? null}
        stadium={board?.stadium ?? null}
      >
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
      </Board>
    </section>
  );
}
