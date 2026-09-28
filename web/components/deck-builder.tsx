import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
 * 公式のデッキコードで読み込んだデッキの、取り込めなかったカードとまだ決まっていないカード。
 * `deck` はこの画面が最後に置いたデッキで、ほかの操作で組み替わっていたら出さない。
 * 候補を押させると、読み込んだのとは別のデッキにカードが足される。
 *
 * 検査の結果とは別に持つ。同じ欄にすると、対戦に入る画面が理由を書くたびに選ぶ欄が消える。
 */
interface OfficialImport {
  deck: string | null;
  missing: string[];
  pending: PendingGroup[];
}

export interface DeckMessage {
  messages: string[];
  tone: "ok" | "ng" | "";
  /**
   * 何についての文か。このデッキから組み替わったら出さない。別のタブで組み替えることもあり、
   * 返事を待つあいだに組み替えることもある。
   */
  deck: string | null;
}

export const NO_DECK_STATUS: DeckMessage = { messages: [], tone: "", deck: null };

/**
 * 組み替わったあとに届いた、前のデッキについての文を捨てる。欄に置くと、いまのデッキについての
 * 新しい文を上書きする。
 */
export function forCurrentDeck(
  show: (message: DeckMessage) => void,
): (message: DeckMessage) => void {
  return (message) => {
    if (message.deck === storedDeckJson()) show(message);
  };
}

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
  status: DeckMessage;
  onStatus: (status: DeckMessage) => void;
  actions: ReactNode;
}) {
  const { table } = useCardData();
  const post = forCurrentDeck(onStatus);
  const deckJson = useSyncExternalStore(subscribeDeck, storedDeckJson);
  const entries = useMemo(() => parseDeck(deckJson), [deckJson]);
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [importing, setImporting] = useState(false);
  const [official, setOfficial] = useState<OfficialImport | null>(null);
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
    setOfficial(null);
    say([], "");
  };

  const say = (messages: string[], tone: DeckMessage["tone"], deck = storedDeckJson()) =>
    post({ messages, tone, deck });

  const check = async () => {
    const deck = storedDeckJson();
    if (parseDeck(deck).length === 0) {
      say(["デッキにカードがありません。"], "ng", deck);
      return;
    }
    await validate(deck);
  };

  /** 失敗の文も、確かめたデッキに付ける。選んだカードを置いてから確かめるので、押す前のデッキではない。 */
  const validate = async (deck: string | null) => {
    let outcome: { errors?: string[] };
    try {
      outcome = await postJson("/api/deck/validate", deckCards(parseDeck(deck)));
    } catch (error) {
      fail("確かめられませんでした", deck)(error);
      return;
    }
    showVerdict(outcome.errors ?? [], deck);
  };

  const showVerdict = (errors: readonly string[], deck: string | null) =>
    errors.length === 0
      ? say([`デッキは ${deckSize(parseDeck(deck))} 枚で、規則を通ります。`], "ok", deck)
      : say([...errors], "ng", deck);

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
    const before = storedDeckJson();
    setOfficial(null);
    say(["公式サイトからデッキを読んでいます。"], "");
    // 待つあいだに組み替えていたら、読み込みの結果は前のデッキについてのものなので出さない。
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
    if (storedDeckJson() !== before) {
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
    saveDeck(outcome.entries);
    const deck = storedDeckJson();
    setOfficial({ deck, missing, pending });
    // 選び終えるまでの検査の結果は、足りない枚数を言うだけである。選び終えたら確かめ直す。
    if (pending.length > 0) say([], "");
    else showVerdict(outcome.errors ?? [], deck);
  };

  /**
   * 決まっていないカードを 1 枚選ぶ。左右 2 枚で 1 つのスタジアムは公式サイトでは 1 つのカードなので、
   * 枚数を左右にどう分けるかはデッキコードからは分からない。
   */
  const pick = async (current: OfficialImport, group: number, defId: string) => {
    if (current.pending[group]?.left === 0) return;
    if (current.deck !== storedDeckJson()) {
      say(["デッキが変わっています。もう一度デッキコードを読み込んでください。"], "ng");
      return;
    }
    const next = withCount(storedDeck(), defId, 1);
    saveDeck(next);
    const pending = current.pending.map((each, index) =>
      index === group ? { ...each, left: each.left - 1 } : each,
    );
    const deck = storedDeckJson();
    setOfficial({ ...current, deck, pending });
    if (pending.some((each) => each.left > 0)) return;
    say(["デッキを確かめています。"], "", deck);
    await validate(deck);
  };

  /** `deck` は、失敗した操作が扱っていたデッキ。 */
  const fail = (lead: string, deck: string | null) => (error: unknown) =>
    say([`${lead}: ${messageOf(error)}`], "ng", deck);

  const startImport = () => {
    if (importing) return;
    if (entries.length > 0 && !confirm("いまのデッキと置き換えますか。")) return;
    setImporting(true);
    importCode()
      .catch(fail("読み込めませんでした", storedDeckJson()))
      .finally(() => setImporting(false));
  };

  const total = deckSize(entries);
  const picking = official !== null && official.deck === deckJson ? official : null;
  const shown = shownStatus(picking, status, deckJson);
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
        <button id="check-button" className="secondary" onClick={() => void check()}>
          デッキを確かめる
        </button>
        <button
          id="clear-button"
          className="secondary"
          onClick={() => {
            if (entries.length === 0 || !confirm("デッキを空にしますか。")) return;
            saveDeck([]);
            setOfficial(null);
            say([], "");
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
                    onClick={() => void pick(picking, index, choice.defId)}
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

/**
 * 欄に出すもの。読み込んだデッキの残りを先に、ほかの文をあとに並べる。
 * どちらも、いまのデッキについてのものだけ出す。
 */
function shownStatus(
  picking: OfficialImport | null,
  status: DeckMessage,
  deck: string | null,
): Pick<DeckMessage, "messages" | "tone"> {
  const current = status.deck === deck;
  const messages = [
    ...(picking?.missing ?? []),
    ...(picking?.pending ?? [])
      .filter((group) => group.left > 0)
      .map(
        (group) =>
          `${group.name} は ${group.choices.length} 通りあります。あと ${group.left} 枚を選んでください。`,
      ),
    ...(current ? status.messages : []),
  ];
  const tone = (picking?.missing.length ?? 0) > 0 ? "ng" : current ? status.tone : "";
  return { messages, tone };
}
