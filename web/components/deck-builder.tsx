import { useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { messageOf, postJson } from "../lib/api.js";
import { useCardData, type CardTable } from "../lib/cards.js";
import {
  canAdd,
  deckCodeOf,
  deckSize,
  DECK_SIZE,
  fetchOfficialDeck,
  saveDeck,
  searchCards,
  searchRows,
  searchWords,
  withCount,
  type CardChoice,
  type DeckEntry,
  type OfficialFailure,
  type SavedDeck,
} from "../lib/deck.js";
import { describeCard, KIND_ORDER, KINDS } from "../lib/describe.js";
import { CardFace } from "./board.js";

const SEARCH_LIMIT = 30;

/** 公式のデッキコードで読み込んだとき、まだ決まっていないカードの 1 つ。 */
interface PendingGroup {
  name: string;
  choices: CardChoice[];
  /** あと何枚選ぶか。 */
  left: number;
}

/**
 * 公式のデッキコードで読み込んだデッキの、取り込めなかったカードとまだ決まっていないカード。
 * `entries` はこの画面が最後に置いたデッキで、ほかの操作で組み替わったら出さない。
 * 候補を押させると、読み込んだのとは別のデッキにカードが足される。
 */
interface OfficialImport {
  entries: readonly DeckEntry[];
  missing: string[];
  pending: PendingGroup[];
}

/** 欄に出す文。`entries` はどのデッキについての文かで、組み替わったら出さない。 */
interface DeckMessage {
  messages: string[];
  tone: "ok" | "ng" | "";
  entries: readonly DeckEntry[];
}

/**
 * デッキを組んで保存する。`saved` が null なら新しいデッキで、保存するとそのデッキのページへ移る。
 *
 * 組みかけは保存するまでこの画面の中だけにある。規則に通るかは、保存したときにサーバが照らした結果を出す（仕様 5.5 節）。
 */
export function DeckBuilder({ saved }: { saved: SavedDeck | null }) {
  const { table } = useCardData();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(saved?.name ?? "");
  const [entries, setEntries] = useState<readonly DeckEntry[]>(saved?.cards ?? []);
  /** 読み込みの返事を待つあいだに組み替えたかを、描き直しを待たずに見る。 */
  const latest = useRef(entries);
  const [status, setStatus] = useState<DeckMessage | null>(null);
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [official, setOfficial] = useState<OfficialImport | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => searchRows(table), [table]);
  const found = useMemo(() => searchCards(rows, query), [rows, query]);
  const loaded = Object.keys(table).length > 0;

  const unsaved =
    saved === null
      ? name !== "" || entries.length > 0
      : name !== saved.name || JSON.stringify(entries) !== JSON.stringify(saved.cards);
  useBlocker({
    shouldBlockFn: () => unsaved && !confirm("保存していない変更を捨てますか。"),
    enableBeforeUnload: () => unsaved,
  });

  const put = (next: readonly DeckEntry[]) => {
    latest.current = next;
    setEntries(next);
  };
  const say = (messages: string[], tone: DeckMessage["tone"], about = latest.current) =>
    setStatus({ messages, tone, entries: about });

  /**
   * 組み替える。押したボタンが押せなくなるなら、フォーカスを同じ行のもう片方か検索欄へ移す。
   * 押せないボタンに残ると、キーボードではページの先頭からたどり直すことになる。
   */
  const change = (defId: string, delta: number, button: HTMLButtonElement) => {
    const next = withCount(latest.current, defId, delta);
    const stillThere = next.some((entry) => entry.defId === defId);
    const pressable = delta > 0 ? canAdd(next, table, defId) : stillThere;
    if (!pressable && document.activeElement === button) {
      const sibling = stillThere
        ? [...(button.closest(".card-row")?.querySelectorAll("button") ?? [])].find(
            (other) => other !== button && !other.disabled,
          )
        : undefined;
      (sibling ?? search.current)?.focus();
    }
    put(next);
    setOfficial(null);
  };

  const save = async () => {
    const cards = latest.current;
    const sentName = name;
    const deck = await saveDeck(queryClient, {
      ...(saved === null ? {} : { deckId: saved.deckId }),
      name: sentName,
      cards,
    });
    if (saved === null) {
      // 保存したので、捨てる変更は無い。移った先のページは、保存したデッキを一覧から読み直す。
      await navigate({
        to: "/decks/$deckId",
        params: { deckId: deck.deckId },
        replace: true,
        ignoreBlocker: true,
      });
      return;
    }
    // サーバは見えない字を落として名前を付ける。待つあいだに打ち直した名前は残す。
    setName((current) => (current === sentName ? deck.name : current));
    say([], "", cards);
  };

  /**
   * 公式のデッキコードのデッキと置き換える。取り込めないカードがあっても、取り込めたぶんで
   * 置き換え、残りはどのカードかを公式のページにある名前で出す。
   */
  const importCode = async () => {
    const parsed = deckCodeOf(code);
    if (parsed === null) {
      say(["デッキコードか、公式サイトのデッキのページの URL を入れてください。"], "ng");
      return;
    }
    const before = latest.current;
    setOfficial(null);
    say(["公式サイトからデッキを読んでいます。"], "");
    const page = await fetchOfficialDeck(parsed);
    if (page === null) {
      say([`デッキコード ${parsed} のデッキは公式サイトにありません。`], "ng", before);
      return;
    }
    const outcome = await postJson<{
      entries?: DeckEntry[];
      failures: OfficialFailure[];
      errors?: string[];
    }>("/api/deck/official", { cards: page.cards });
    if (outcome.entries === undefined) {
      say(outcome.errors ?? ["読み込めませんでした。"], "ng", before);
      return;
    }
    // 待つあいだに組み替えられていたら、置き換えると組み替えたぶんが黙って消える。
    if (latest.current !== before) {
      say(["読み込むあいだにデッキが変わったので、置き換えませんでした。"], "ng");
      return;
    }
    const officialName = (cardId: string) => page.names[cardId] ?? `カード ID ${cardId}`;
    const missing: string[] = [];
    const pending: PendingGroup[] = [];
    for (const failure of outcome.failures) {
      if (failure.kind === "ambiguous") {
        pending.push({
          name: officialName(failure.cardId),
          choices: failure.choices,
          left: failure.count,
        });
      } else {
        missing.push(
          `このサーバに無いカードです: ${officialName(failure.cardId)} ${failure.count} 枚`,
        );
      }
    }
    // 1 枚も決まらず選ぶものも無ければ、組んでいるデッキを空にしてまで置き換えない。
    if (outcome.entries.length === 0 && pending.length === 0) {
      say(missing, "ng");
      return;
    }
    put(outcome.entries);
    setOfficial({ entries: outcome.entries, missing, pending });
    say([], "");
  };

  /**
   * 決まっていないカードを 1 枚選ぶ。左右 2 枚で 1 つのスタジアムは公式サイトでは 1 つのカードなので、
   * 枚数を左右にどう分けるかはデッキコードからは分からない。
   */
  const pick = (current: OfficialImport, group: number, defId: string) => {
    if (current.pending[group]?.left === 0 || current.entries !== latest.current) return;
    const next = withCount(latest.current, defId, 1);
    put(next);
    const pending = current.pending.map((each, index) =>
      index === group ? { ...each, left: each.left - 1 } : each,
    );
    setOfficial({ ...current, entries: next, pending });
  };

  const run = (task: () => Promise<void>, lead: string, setBusy: (busy: boolean) => void) => {
    const about = latest.current;
    setBusy(true);
    task()
      .catch((error: unknown) => say([`${lead}: ${messageOf(error)}`], "ng", about))
      .finally(() => setBusy(false));
  };

  const startImport = () => {
    if (importing) return;
    if (latest.current.length > 0 && !confirm("いまのデッキと置き換えますか。")) return;
    run(importCode, "読み込めませんでした", setImporting);
  };

  const total = deckSize(entries);
  const picking = official !== null && official.entries === entries ? official : null;
  const shown = shownStatus({ picking, status, entries, saved, unsaved });
  const words = searchWords(query);

  return (
    <section id="deck-builder">
      <p>
        <Link to="/decks">デッキの一覧へ</Link>
      </p>
      <div className="builder-head">
        <input
          id="deck-name"
          aria-label="デッキの名前"
          placeholder="デッキの名前"
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          id="save-deck-button"
          className="primary"
          // 返事を待つあいだに押し直すと、新しいデッキが 2 つできる。
          disabled={saving || !unsaved}
          onClick={() => run(save, "保存できませんでした", setSaving)}
        >
          保存する
        </button>
      </div>
      <div id="deck-status" className={`deck-status ${shown.tone}`}>
        {shown.messages.map((message, index) => (
          // 同じ文言が並ぶことがある。並びは届いた答えのまま変わらない。
          // oxlint-disable-next-line react/no-array-index-key
          <p key={index}>{message}</p>
        ))}
        {picking?.pending.map(
          (group, index) =>
            group.left > 0 && (
              // 同じ名前のカードが 2 つの組に分かれることは無い。並びも読み込んだときのまま変わらない。
              // oxlint-disable-next-line react/no-array-index-key
              <div key={index} className="choices">
                {group.choices.map((choice) => (
                  <button
                    key={choice.defId}
                    type="button"
                    onClick={() => pick(picking, index, choice.defId)}
                  >
                    {`${group.name}（${describeCard(choice) || choice.defId}）`}
                  </button>
                ))}
              </div>
            ),
        )}
      </div>
      <details className="deck-code" open={saved === null}>
        <summary>公式のデッキコードから読み込む</summary>
        <div className="deck-code-form">
          <input
            id="deck-code"
            aria-label="公式のデッキコード"
            placeholder="コードか、デッキのページの URL"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") startImport();
            }}
          />
          <button
            id="deck-code-button"
            className="secondary"
            // 公式サイトの返事を待つあいだに 2 度押されると、2 つの結果が前後して書き込まれる。
            disabled={importing}
            onClick={startImport}
          >
            読み込む
          </button>
        </div>
      </details>

      <div className="builder-columns">
        <div>
          <h2>カードをさがす</h2>
          <input
            ref={search}
            id="card-search"
            type="search"
            placeholder="カード名、ワザの名前、収録で検索"
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div id="card-results" className="card-list">
            {words.length > 0 && !loaded && (
              <p className="note">カードの一覧を読み込んでいます。</p>
            )}
            {words.length > 0 && loaded && found.length === 0 && (
              <p className="note">見つかりません。</p>
            )}
            {found.slice(0, SEARCH_LIMIT).map(({ defId }) => {
              const inDeck = entries.find((entry) => entry.defId === defId)?.count ?? 0;
              return (
                <CardRow key={defId} defId={defId} table={table}>
                  <span className="card-count">{inDeck === 0 ? "" : `${inDeck} 枚`}</span>
                  <button
                    type="button"
                    className="secondary add"
                    disabled={!canAdd(entries, table, defId)}
                    onClick={(event) => change(defId, 1, event.currentTarget)}
                  >
                    追加
                  </button>
                </CardRow>
              );
            })}
            {found.length > SEARCH_LIMIT && (
              <p className="note">
                ほかに {found.length - SEARCH_LIMIT}{" "}
                件あります。ワザの名前などを空白のあとに打ち足すと絞れます。
              </p>
            )}
          </div>
        </div>
        <div>
          <h2 id="deck-count" className={total === DECK_SIZE ? "deck-count full" : "deck-count"}>
            {total === 0 ? "デッキは空です" : `${total} / ${DECK_SIZE} 枚`}
          </h2>
          <div id="deck-cards" className="card-list">
            {/* 名前の表が届くまでは、defId しか出せないので並べない。 */}
            {!loaded && total > 0 && <p className="note">カードの一覧を読み込んでいます。</p>}
            {loaded &&
              groupByKind(entries, table).map(({ kind, group }) => (
                <DeckGroup key={kind ?? ""} kind={kind} count={deckSize(group)}>
                  {group.map(({ defId, count }) => (
                    <CardRow key={defId} defId={defId} table={table}>
                      <button
                        type="button"
                        className="secondary remove"
                        onClick={(event) => change(defId, -1, event.currentTarget)}
                      >
                        −
                      </button>
                      <span className="card-count">{count}</span>
                      <button
                        type="button"
                        className="secondary add"
                        disabled={!canAdd(entries, table, defId)}
                        onClick={(event) => change(defId, 1, event.currentTarget)}
                      >
                        ＋
                      </button>
                    </CardRow>
                  ))}
                </DeckGroup>
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function CardRow({
  defId,
  table,
  children,
}: {
  defId: string;
  table: CardTable;
  children: ReactNode;
}) {
  const card = table[defId];
  return (
    <div className="card-row" data-def-id={defId}>
      <CardFace defId={defId} thumb />
      <span className="card-label">
        <strong>{card?.name ?? defId}</strong>{" "}
        <span className="card-detail">{describeCard(card)}</span>
      </span>
      {children}
    </div>
  );
}

function DeckGroup({
  kind,
  count,
  children,
}: {
  kind: string | null;
  count: number;
  children: ReactNode;
}) {
  return (
    <>
      <h3>{`${kind === null ? "そのほか" : KINDS[kind]} ${count} 枚`}</h3>
      {children}
    </>
  );
}

/** 種類ごとに分ける。種類の分からないカードは最後にまとめる。 */
function groupByKind(
  entries: readonly DeckEntry[],
  table: CardTable,
): { kind: string | null; group: DeckEntry[] }[] {
  const kindOf = (entry: DeckEntry) => {
    const kind = table[entry.defId]?.kind;
    return kind !== undefined && KIND_ORDER.includes(kind) ? kind : null;
  };
  return [...KIND_ORDER, null]
    .map((kind) => ({ kind, group: entries.filter((entry) => kindOf(entry) === kind) }))
    .filter(({ group }) => group.length > 0);
}

/**
 * 欄に出すもの。読み込んだデッキの残り、この画面の操作の文、保存したデッキを照らした結果の順に並べる。
 * 照らした結果は、保存したときのデッキのままのときだけ出す。組み替えたら、保存していないことを出す。
 */
function shownStatus({
  picking,
  status,
  entries,
  saved,
  unsaved,
}: {
  picking: OfficialImport | null;
  status: DeckMessage | null;
  entries: readonly DeckEntry[];
  saved: SavedDeck | null;
  unsaved: boolean;
}): Pick<DeckMessage, "messages" | "tone"> {
  const current = status !== null && status.entries === entries ? status : null;
  const verdict = unsaved
    ? { messages: ["保存していない変更があります。"], tone: "" as const }
    : saved === null
      ? null
      : saved.errors.length === 0
        ? { messages: [`${deckSize(saved.cards)} 枚で、規則を通ります。`], tone: "ok" as const }
        : { messages: ["このままでは対戦に出せません。", ...saved.errors], tone: "ng" as const };
  const messages = [
    ...(picking?.missing ?? []),
    ...(picking?.pending ?? [])
      .filter((group) => group.left > 0)
      .map(
        (group) =>
          `${group.name} は ${group.choices.length} 通りあります。あと ${group.left} 枚を選んでください。`,
      ),
    ...(current?.messages ?? []),
    ...(verdict?.messages ?? []),
  ];
  const tone =
    (picking?.missing.length ?? 0) > 0 || current?.tone === "ng"
      ? "ng"
      : ((current?.tone || verdict?.tone) ?? "");
  return { messages, tone };
}
