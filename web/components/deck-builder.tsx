import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { messageOf, postJson } from "../lib/api.js";
import { useCardData, type CardTable } from "../lib/cards.js";
import {
  canAdd,
  deckCards,
  deckCodeOf,
  deckSize,
  DECK_SIZE,
  fetchOfficialDeck,
  parseDeck,
  saveDeck,
  searchCards,
  searchRows,
  searchWords,
  storedDeck,
  storedDeckJson,
  subscribeDeck,
  withCount,
  type CardChoice,
  type DeckEntry,
  type OfficialFailure,
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
 * 公式のデッキコードで読み込んだデッキの、まだ決まっていないカードと画面に出す理由。
 * `deck` はこの画面が最後に置いたデッキで、ほかの操作で組み替わっていたら候補を押させない。
 * 押させると、読み込んだのとは別のデッキにカードが足される。
 */
interface OfficialImport {
  deck: string | null;
  missing: string[];
  pending: PendingGroup[];
  /** 検査の結果。選び終えてから結果が届くまでは null。 */
  errors: string[] | null;
}

export interface DeckMessage {
  messages: string[];
  tone: "ok" | "ng" | "";
  /**
   * 検査の結果なら、確かめたデッキ。組み替わったら出さない。別のタブで組み替えることもあり、
   * 返事を待つあいだに組み替えることもある。
   */
  deck?: string | null;
}

export type DeckStatus = DeckMessage | { official: OfficialImport };

export const NO_DECK_STATUS: DeckMessage = { messages: [], tone: "" };

/**
 * デッキを組む。組んだデッキはこのブラウザに残り、対戦に入るときはそれを出す。
 *
 * `status` は組む画面と対戦に入る画面が一緒に使う欄で、デッキが規則に通らない理由もここに出る。
 * `actions` は、組む画面のボタンの並びに添えるもの。
 */
export function DeckBuilder({
  status,
  onStatus,
  actions,
}: {
  status: DeckStatus;
  onStatus: Dispatch<SetStateAction<DeckStatus>>;
  actions: ReactNode;
}) {
  const { table } = useCardData();
  const deckJson = useSyncExternalStore(subscribeDeck, storedDeckJson);
  const entries = useMemo(() => parseDeck(deckJson), [deckJson]);
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [importing, setImporting] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => searchRows(table), [table]);
  const found = useMemo(() => searchCards(rows, query), [rows, query]);
  const loaded = Object.keys(table).length > 0;

  /**
   * 組み替える。押したボタンが押せなくなるなら、フォーカスを同じ行のもう片方か検索欄へ移す。
   * 押せないボタンに残ると、キーボードではページの先頭からたどり直すことになる。
   */
  const change = (defId: string, delta: number, button: HTMLButtonElement) => {
    const next = withCount(storedDeck(), defId, delta);
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
    saveDeck(next);
    // 前に出した検査の結果は、組み替えた時点で古くなる。
    onStatus(NO_DECK_STATUS);
  };

  const check = async () => {
    if (entries.length === 0) {
      onStatus({ messages: ["デッキにカードがありません。"], tone: "ng" });
      return;
    }
    const deck = storedDeckJson();
    const outcome = await postJson<{ ok: boolean; errors?: string[] }>(
      "/api/deck/validate",
      deckCards(entries),
    );
    onStatus(
      outcome.ok
        ? { messages: [`デッキは ${deckSize(entries)} 枚で、規則を通ります。`], tone: "ok", deck }
        : { messages: outcome.errors ?? ["デッキが通りませんでした。"], tone: "ng", deck },
    );
  };

  /**
   * 公式のデッキコードのデッキと置き換える。取り込めないカードがあっても、取り込めたぶんで
   * 置き換え、残りはどのカードかを公式のページにある名前で出す。
   */
  const importCode = async () => {
    const parsed = deckCodeOf(code);
    if (parsed === null) {
      onStatus({
        messages: ["デッキコードか、公式サイトのデッキのページの URL を入れてください。"],
        tone: "ng",
      });
      return;
    }
    const before = storedDeckJson();
    onStatus({ messages: ["公式サイトからデッキを読んでいます。"], tone: "" });
    const official = await fetchOfficialDeck(parsed);
    if (official === null) {
      onStatus({
        messages: [`デッキコード ${parsed} のデッキは公式サイトにありません。`],
        tone: "ng",
      });
      return;
    }
    const outcome = await postJson<{
      entries?: DeckEntry[];
      failures: OfficialFailure[];
      errors?: string[];
    }>("/api/deck/official", { cards: official.cards });
    if (outcome.entries === undefined) {
      onStatus({ messages: outcome.errors ?? ["読み込めませんでした。"], tone: "ng" });
      return;
    }
    // 待つあいだに組み替えられていたら、置き換えると組み替えたぶんが黙って消える。
    if (storedDeckJson() !== before) {
      onStatus({
        messages: ["読み込むあいだにデッキが変わったので、置き換えませんでした。"],
        tone: "ng",
      });
      return;
    }
    const officialName = (cardId: string) => official.names[cardId] ?? `カード ID ${cardId}`;
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
      onStatus({ messages: missing, tone: "ng" });
      return;
    }
    saveDeck(outcome.entries);
    onStatus({
      official: { deck: storedDeckJson(), missing, pending, errors: outcome.errors ?? [] },
    });
  };

  /**
   * 決まっていないカードを 1 枚選ぶ。左右 2 枚で 1 つのスタジアムは公式サイトでは 1 つのカードなので、
   * 枚数を左右にどう分けるかはデッキコードからは分からない。
   */
  const pick = async (current: OfficialImport, group: number, defId: string) => {
    if (current.pending[group]?.left === 0) return;
    if (current.deck !== storedDeckJson()) {
      onStatus({
        messages: ["デッキが変わっています。もう一度デッキコードを読み込んでください。"],
        tone: "ng",
      });
      return;
    }
    const next = withCount(storedDeck(), defId, 1);
    saveDeck(next);
    const pending = current.pending.map((each, index) =>
      index === group ? { ...each, left: each.left - 1 } : each,
    );
    const done = pending.every((each) => each.left === 0);
    // 選び終えたら、検査の結果が届くまでは「確かめています」を出す。
    const picked: OfficialImport = {
      ...current,
      deck: storedDeckJson(),
      pending,
      errors: done ? null : current.errors,
    };
    onStatus({ official: picked });
    if (!done) return;
    const outcome = await postJson<{ errors?: string[] }>("/api/deck/validate", deckCards(next));
    onStatus((latest) =>
      "official" in latest && latest.official === picked && picked.deck === storedDeckJson()
        ? { official: { ...picked, errors: outcome.errors ?? [] } }
        : latest,
    );
  };

  const fail = (lead: string) => (error: unknown) =>
    onStatus({ messages: [`${lead}: ${messageOf(error)}`], tone: "ng" });

  const startImport = () => {
    if (importing) return;
    if (entries.length > 0 && !confirm("いまのデッキと置き換えますか。")) return;
    setImporting(true);
    importCode()
      .catch(fail("読み込めませんでした"))
      .finally(() => setImporting(false));
  };

  const total = deckSize(entries);
  const shown = shownStatus(status, deckJson, total);
  const words = searchWords(query);

  return (
    <>
      <div className="deck-code">
        <label htmlFor="deck-code">公式のデッキコード</label>
        <input
          id="deck-code"
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
      <input
        ref={search}
        id="card-search"
        type="search"
        placeholder="カード名で検索"
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div id="card-results" className="card-list">
        {words.length > 0 && !loaded && <p className="note">カードの一覧を読み込んでいます。</p>}
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
      <p id="deck-count" className={total === DECK_SIZE ? "deck-count full" : "deck-count"}>
        {total === 0 ? "デッキは空です。" : `${total} / ${DECK_SIZE} 枚`}
      </p>
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

      <div className="deck-actions">
        <button
          id="check-button"
          className="secondary"
          onClick={() => void check().catch(fail("確かめられませんでした"))}
        >
          デッキを確かめる
        </button>
        <button
          id="clear-button"
          className="secondary"
          onClick={() => {
            if (entries.length === 0 || !confirm("デッキを空にしますか。")) return;
            saveDeck([]);
            onStatus(NO_DECK_STATUS);
          }}
        >
          デッキを空にする
        </button>
        {actions}
      </div>
      <div id="deck-status" className={`deck-status ${shown.tone}`}>
        {shown.messages.map((message, index) => (
          // 同じ文言が並ぶことがある。並びは届いた答えのまま変わらない。
          // oxlint-disable-next-line react/no-array-index-key
          <p key={index}>{message}</p>
        ))}
        {"official" in status &&
          status.official.deck === deckJson &&
          status.official.pending.map(
            (group, index) =>
              group.left > 0 && (
                // 同じ名前のカードが 2 つの組に分かれることは無い。並びも読み込んだときのまま変わらない。
                // oxlint-disable-next-line react/no-array-index-key
                <div key={index} className="choices">
                  {group.choices.map((choice) => (
                    <button
                      key={choice.defId}
                      type="button"
                      onClick={() =>
                        void pick(status.official, index, choice.defId).catch(
                          fail("確かめられませんでした"),
                        )
                      }
                    >
                      {`${group.name}（${describeCard(choice) || choice.defId}）`}
                    </button>
                  ))}
                </div>
              ),
          )}
      </div>
    </>
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

/** 欄に出すもの。検査の結果は、確かめたデッキがいまのデッキのときだけ出す。 */
function shownStatus(status: DeckStatus, deck: string | null, total: number): DeckMessage {
  if ("official" in status) {
    return status.official.deck === deck ? officialView(status.official, total) : NO_DECK_STATUS;
  }
  return status.deck === undefined || status.deck === deck ? status : NO_DECK_STATUS;
}

function officialView(official: OfficialImport, total: number): DeckMessage {
  const open = official.pending.filter((group) => group.left > 0);
  const messages = [...official.missing];
  for (const group of open) {
    messages.push(
      `${group.name} は ${group.choices.length} 通りあります。あと ${group.left} 枚を選んでください。`,
    );
  }
  if (official.errors === null) messages.push("デッキを確かめています。");
  else if (open.length === 0) messages.push(...official.errors);
  const ok = open.length === 0 && official.missing.length === 0 && official.errors?.length === 0;
  if (ok) messages.push(`デッキは ${total} 枚で、規則を通ります。`);
  return { messages, tone: ok ? "ok" : official.errors === null ? "" : "ng" };
}
