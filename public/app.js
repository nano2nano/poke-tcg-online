/**
 * 参照クライアント（`docs/spec/battle-server.md` 0 節「スコープ外」）。
 *
 * 見た目は仕様の対象外なので、この画面はプロトコルが運ぶ値を卓の配置に並べるだけにする。
 * **盤面の判断を一切持たない。** サーバが送ってきた合法手を並べ、押された 1 つを送り返す。
 * 残りの HP のような、射影に無い値も計算しない。どうぐや効果で最大 HP が変わると、画面だけが嘘をつく。
 * 権威はサーバの局面にあり、こちらは描くだけである（1 節の S-1）。
 */

const $ = (id) => document.getElementById(id);

/** defId から名前を引く表。対戦ごとに変わらないので一度だけ取る。 */
let cards = {};
let loadingCards = null;
/** `cards` から作った検索用の形。`cards` が差し替わったら作り直す。 */
let searchIndex = null;
let socket = null;
let seat = null;
/** 着いている座席。決着のあとにシャッフルを検算するため、シェアとコミットもここに持つ。 */
let seatedNow = null;
let stateVersion = 0;
/** 直近の盤面。手の見出しでインスタンス ID からカードの名前を引くのに使う。 */
let lastView = null;
/** 直近の指せる手。カードの名前の表が遅れて届いたときに、手の見出しを描き直す。 */
let lastMoves = { moves: null, playing: false, setup: null };
/** 対戦準備で選びかけのバトル場とベンチ。局面が届き直しても、選んだところを残す。 */
let setupDraft = { active: null, bench: [], sent: false };
/** 対戦準備で引き直すときに見せた手札。名前の表が遅れて届いたら描き直す。 */
let lastMulligans = [];
/** 前に描いたときに準備の中だったか。欄を開け閉めするのは、準備が終わったときと増えたときだけにする。 */
let mulligansInSetup = false;
/** 実行中のプレイヤーの読み込み。`ensureAccount` がこれを待ち合わせる。 */
let loadingAccount = null;
/**
 * 着いている座席への接続。切れたら同じ座席トークンで繋ぎ直す（3.3 節）。
 * 切断中も時計は流れる（3.4 節）ので、読み込み直すのを待っていると、そのあいだに負ける。
 */
let seatLink = null;

/**
 * 指している座席を置く鍵。
 *
 * **持たずに閉じると、その対戦には二度と入れない。** 繋ぎ直しに要るのは座席トークンだけ
 * （3.3 節）だが、この画面はそれを対戦のあいだメモリに持つだけだった。切断中も時計は
 * 流れるので（3.4 節）、戻れないまま時間切れで負ける。
 */
const SEAT_KEY = "poke-seat";

/**
 * 公式サイトのデッキ確認ページ。ブラウザから直接取る（仕様 5.4 節）。このページは
 * どのオリジンからの読み取りも許しているので、サーバを中継させずに済む。
 */
const OFFICIAL_DECK_PAGE = "https://www.pokemon-card.com/deck/confirm.html/deckID/";

/** 組んでいるデッキを置く localStorage のキー。開き直すたびに組み直させないよう、ブラウザに残す。 */
const DECK_KEY = "poke-deck";

/**
 * 画面が「追加」を止める枚数。デッキとして通るかを決めるのはサーバの検査（5.1 節）で、
 * ここは押し過ぎを先に止めるだけである。
 */
const DECK_SIZE = 60;
const SAME_NAME_LIMIT = 4;
const ACE_SPEC_LIMIT = 1;

const STAGES = { basic: "たね", stage1: "1 進化", stage2: "2 進化" };
const KINDS = { pokemon: "ポケモン", trainer: "トレーナーズ", energy: "エネルギー" };
const TYPES = {
  grass: "草",
  fire: "炎",
  water: "水",
  lightning: "雷",
  psychic: "超",
  fighting: "闘",
  darkness: "悪",
  metal: "鋼",
  dragon: "竜",
  colorless: "無色",
};
const TRAINER_KINDS = {
  item: "グッズ",
  supporter: "サポート",
  tool: "ポケモンのどうぐ",
  stadium: "スタジアム",
};
const HALVES = { left: "左", right: "右" };
const WIN_REASONS = {
  "prizes-taken": "サイドを取りきった",
  "no-pokemon": "場のポケモンがいなくなった",
  "deck-out": "山札を引けなかった",
  "effect-declared": "カードの効果",
  "turn-limit": "手数の上限",
};
/** 手を断った理由（仕様 2.2 節）。 */
const REJECT_REASONS = {
  "not-your-turn": "あなたの番ではありません",
  "stale-version": "盤面が先に進んでいました",
  "illegal-move": "いまは指せない手です",
  "match-over": "対戦は終わっています",
};
const CONDITIONS = {
  poisoned: "どく",
  burned: "やけど",
  asleep: "ねむり",
  paralyzed: "マヒ",
  confused: "こんらん",
};

/**
 * 公式のカード画像を出すか。出すかどうかはサーバの設定で決まる（仕様 3.7 節）。
 * 取れなければ出さない。カードは画像が無くても、名前と種類の面で描ける。
 */
let cardImages = false;
/**
 * 読めなかった画像。盤面は 1 手ごとに描き直すので、覚えておかないと公式が落ちているあいだ
 * 1 手ごとに全部のカードを頼み直す。開き直せば、もう一度頼む。
 */
const failedImages = new Set();

/** 検索で並べる上限。これより多ければ、語を打ち足して絞ってもらう。 */
const SEARCH_LIMIT = 30;

/** 組んでいるデッキ。`defId` と枚数を、足した順に持つ。送る並びも対局ログに残る（6.2 節）。 */
let deckEntries = loadDeck();

const nameOf = (defId) => cards[defId]?.name ?? defId;

$("join-button").addEventListener("click", () => {
  join().catch((error) => setStatus(`つながらなかった: ${error.message}`));
});

/**
 * 人が表示名を触ったか。
 *
 * 読み込みは非同期なので、返ってくる前に表示名を書き換えて「対戦をさがす」を
 * 押せてしまう。 そこで欄を埋め直すと、打った名前が消えてから送られる。
 */
let nameTouched = false;
$("name").addEventListener("input", () => {
  nameTouched = true;
});

const watchToken = new URLSearchParams(location.search).get("watch");

/**
 * **観戦で開いたときは、プレイヤーを作らない。** プレイヤーを消す道は無いので、
 * リンクを開いただけの人のぶんが残り続ける。覚えている座席へも繋ぎに行かない。
 * 繋ぐと観戦の画面の裏で対戦が開き、どちらを見ているのか分からなくなる。
 */
loadDisplayConfig();

if (watchToken !== null) {
  openWatch(watchToken);
} else {
  ensureAccount().catch((error) => setStatus(`アカウントを読めませんでした: ${error.message}`));
  resumeSeat();
  renderDeck();
  loadCardsForJoin();
}

/**
 * 覚えている座席があれば、そこへ繋ぎ直す。
 *
 * **カードの名前の表を待たずに繋ぐ。** 指していないあいだも時計は流れるので（3.4 節）、
 * 取りに行っているあいだに手番が終わる。表が届いたら、そのとき出ている盤面を描き直す。
 */
function resumeSeat() {
  const seated = storedSeat();
  if (seated === null) return;
  openMatch(seated);
}

/**
 * 名前の表を取る。取りに行っている最中なら同じ要求を待つ。失敗したら次に呼ばれたときに
 * 取り直す。1 度の失敗で諦めると、読み込み直すまでデッキを組めない。
 */
function loadCards() {
  loadingCards ??= getJson("/api/cards").then(
    (loaded) => {
      cards = loaded;
    },
    (error) => {
      loadingCards = null;
      throw error;
    },
  );
  return loadingCards;
}

/**
 * 対戦に入る画面の名前の表。取れるまで間を空けて取り直す。取れないとデッキを組めず、
 * 繋ぎ直した盤面の名前も出ない。取り直すのは取れなかったときだけで、描く側の例外は拾わない。
 */
function loadCardsForJoin(delayMs = 5_000) {
  loadCards().then(redraw, () =>
    setTimeout(() => loadCardsForJoin(Math.min(delayMs * 2, 60_000)), delayMs),
  );
}

function loadDisplayConfig() {
  getJson("/api/config").then(
    (config) => {
      cardImages = config.cardImages === true;
      if (cardImages) redraw();
    },
    () => {},
  );
}

/** 名前の表や画像の設定が遅れて届いたときに、出ている画面を描き直す。 */
function redraw() {
  const restore = focusedRowButton();
  renderDeck();
  renderSearch();
  restore();
  if (lastView !== null) {
    renderView(lastView);
    renderMoves(lastMoves.moves, lastMoves.playing, lastMoves.setup);
    renderMulligans(lastMulligans);
  }
  if (lastWatchView !== null) renderWatch(lastWatchView);
  if (lastReplayFrame !== null) renderReplayBoard(lastReplayFrame);
}

/** 名前の表を待たずに描き始める画面向け。届いたら `redraw` で描き直す。 */
function loadCardsThen(redraw) {
  loadCards()
    .then(redraw)
    .catch(() => {});
}

/**
 * 開いている間、20 秒ごとに `ping` を送る。サーバは 150 秒何も届かない接続を切る（仕様 3.5 節）。
 * Cloudflare Workers にはサーバから ping を送る手段が無いので、生きていることは画面の側から伝える。
 *
 * 開いてから、または `ping` を送ってから、次に送るときまでに何も届かなければ、接続を閉じて
 * `onSilent` を呼ぶ（同じ節）。線が途中で切れると `close` はいつまでも来ず、繋ぎ直しが始まらない。
 */
function keepAlive(ws, onSilent) {
  let answered = false;
  ws.addEventListener("message", () => {
    answered = true;
  });
  const timer = setInterval(() => {
    if (!answered) {
      clearInterval(timer);
      ws.close();
      onSilent();
      return;
    }
    answered = false;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" }));
  }, 20_000);
  ws.addEventListener("close", () => clearInterval(timer));
}

function socketUrl(query) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws?${query}`;
}

function moveRemainingText(clock) {
  return clock.moveRemainingMs === null
    ? ""
    : `（この手の残り ${Math.round(clock.moveRemainingMs / 1000)} 秒）`;
}

/** レーティングと戦績を引き直す。対戦が終われば動くので、そのたびに読む。 */
async function refreshAccount() {
  const secret = storedSecret();
  if (secret === null) return;
  const response = await fetch("/api/account/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  if (response.ok) showAccount(await response.json());
}

$("check-button").addEventListener("click", () => {
  checkDeck()
    .then((deck) => {
      if (deck !== null)
        showDeckStatus([`デッキは ${deck.cards.length} 枚で、規則を通ります。`], "ok");
    })
    .catch((error) => showDeckStatus([`確かめられませんでした: ${error.message}`], "ng"));
});

$("card-search").addEventListener("input", renderSearch);

$("import-button").addEventListener("click", () => {
  if (deckEntries.length > 0 && !confirm("いまのデッキと置き換えますか。")) return;
  importText().catch((error) => showDeckStatus([`読み込めませんでした: ${error.message}`], "ng"));
});

$("deck-code-button").addEventListener("click", () => {
  if (deckEntries.length > 0 && !confirm("いまのデッキと置き換えますか。")) return;
  const button = $("deck-code-button");
  // 公式サイトの返事を待つあいだに 2 度押されると、2 つの結果が前後して書き込まれる。
  button.disabled = true;
  importDeckCode()
    .catch((error) => showDeckStatus([`読み込めませんでした: ${error.message}`], "ng"))
    .finally(() => (button.disabled = false));
});

$("deck-code").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("deck-code-button").click();
});

$("clear-button").addEventListener("click", () => {
  if (deckEntries.length === 0 || !confirm("デッキを空にしますか。")) return;
  setDeck([]);
});

/** 別のタブで組み替えたら、こちらも合わせる。合わせないと、次に押したときに古い中身で上書きする。 */
window.addEventListener("storage", (event) => {
  // key が null なのは、ストレージごと消されたとき。
  if (event.key !== DECK_KEY && event.key !== null) return;
  deckEntries = loadDeck();
  renderDeck();
  renderSearch();
  // 「規則を通ります」は古くなるので消す。候補のボタンはテキスト欄のものなので残す。
  if ($("deck-status").classList.contains("ok")) showDeckStatus([], "");
});

$("setup-submit").addEventListener("click", () => {
  if (setupDraft.active === null || setupDraft.sent) return;
  // 返事が来るまで押せなくする。2 度目はサーバが断り、通った答えまで失敗に見える。
  setupDraft.sent = true;
  $("setup-submit").disabled = true;
  send({ t: "setup", active: setupDraft.active, bench: setupDraft.bench });
});

$("concede-button").addEventListener("click", () => {
  if (socket !== null && confirm("投了しますか。")) send({ t: "concede" });
});

/**
 * 同じ座席を開いたタブどうしで、繋がったことを知らせ合う。繋ぎ直しを待っているタブが
 * あとから繋ぐと、いま指しているタブがサーバに閉じられる（3.3 節）。
 */
const seatChannel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("poke-seat");
seatChannel?.addEventListener("message", (event) => {
  if (seatLink === null || event.data?.seatToken !== seatLink.seated.seatToken) return;
  replaceSeatLink(seatLink);
});

async function join() {
  setStatus("デッキを送っています");
  await loadCards();
  // ここで名前の欄を書き戻さない。 書き戻すと、入力した名前が消えてから読まれる。
  await ensureAccount();
  const deck = await deckToSubmit();
  if (deck === null) {
    setStatus("デッキを直してから、もう一度おしてください。");
    return;
  }

  const room = $("room").value.trim();
  const contribution = await newSeedShare();
  const request = {
    secret: storedSecret(),
    deck: { cards: deck.cards },
  };
  if (contribution !== null) request.seedShareCommit = contribution.commit;
  // 表示名の変更は、その人が欄を触ったときだけ送る。 表示名の変更は対局ログにも残り、
  // 取り消せない。欄の中身がその人の意思だとは限らない以上、送る条件は「打ったこと」にする。
  if (nameTouched) request.displayName = $("name").value.trim() || "ななし";
  if (room !== "") request.roomCode = room;

  const outcome = await postJson("/api/join", request);
  if (!outcome.ok) {
    // 断られる理由はデッキとは限らない。アカウントが見つからないこともここへ来る。
    // そのときは、この画面が覚えているアカウントがもう無い。読み直しに行かせる。
    // シークレットを捨ててよいかの判断は `/api/account` の経路が持っているので、ここでは忘れるだけにする。
    if (outcome.code === "account-not-found") loadingAccount = null;
    setStatus(`対戦に入れませんでした:\n${outcome.errors.join("\n")}`);
    return;
  }
  const seedShare = contribution?.share ?? null;
  if (outcome.seat !== undefined) {
    openMatch({ ...outcome.seat, seedShare });
    return;
  }
  setStatus("相手を待っています");
  await waitForOpponent(outcome.ticket, seedShare);
}

/**
 * シャッフルへのシェアを作る（仕様 6.4 節）。送るのはコミットだけで、値は席に着いてから開く。
 * `crypto.subtle` は https か localhost でしか使えない。無ければシェアを出さずに入る。
 */
async function newSeedShare() {
  if (globalThis.crypto?.subtle === undefined) return null;
  const share = toHex(crypto.getRandomValues(new Uint8Array(32)));
  return { share, commit: await sha256Hex(`share:${share}`) };
}

async function sha256Hex(text) {
  return toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  );
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 決着のあとに開かれた値を、席に着く前に受け取ったコミットと突き合わせる（仕様 6.4 節）。
 * 比べる相手はサーバが今送ってきた値ではなく、シェアを開く前に覚えた値である。
 * サーバの言い分同士を比べても、あとから選び直した並びは見分けられない。
 */
async function showShuffleCheck(seated, ended) {
  const [result, text] = await verifyShuffle(seated, ended).catch(() => [
    "error",
    "シャッフルを検算できませんでした。",
  ]);
  const shown = $("shuffle-check");
  shown.dataset.result = result;
  shown.textContent = text;
  shown.hidden = false;
}

async function verifyShuffle(seated, ended) {
  if (typeof seated?.seedCommit !== "string" || !Array.isArray(seated.seedShareCommits)) {
    return ["unavailable", "この対戦の開始時の値を覚えていないので、シャッフルを検算できません。"];
  }
  if (globalThis.crypto?.subtle === undefined) {
    return ["unavailable", "この接続（https でない）では、シャッフルを検算できません。"];
  }
  const shares = ended.seedShares;
  const problems = [];
  // 座席の割り当てに載ってきた自分のコミットが、送ったものと同じか。すり替えられていれば、
  // サーバが選んだ値を自分のシェアとして開いても、下の突き合わせは全部通ってしまう。
  if (
    typeof seated.seedShare === "string" &&
    seated.seedShareCommits[seated.seat] !== (await sha256Hex(`share:${seated.seedShare}`))
  ) {
    problems.push("自分のシェアのコミットがすり替えられています");
  }
  if ((await sha256Hex(`commit:${ended.seedNonce}`)) !== seated.seedCommit) {
    problems.push("サーバのコミットと合いません");
  }
  for (const side of [0, 1]) {
    const share = shares[side];
    if (share === null) continue;
    const commit = seated.seedShareCommits[side];
    if (commit === null || (await sha256Hex(`share:${share}`)) !== commit) {
      problems.push(`${side === seated.seat ? "自分" : "相手"}のシェアがコミットと合いません`);
    }
  }
  const input =
    shares[0] === null && shares[1] === null
      ? `seed:${ended.seedNonce}`
      : `seed:${ended.seedNonce}:${shares[0] ?? ""}:${shares[1] ?? ""}`;
  if ((await sha256Hex(input)).slice(0, 32) !== ended.seed) {
    problems.push("seed が開かれた値から導けません");
  }
  if (problems.length > 0) {
    return ["mismatch", `シャッフルの検算が合いません: ${problems.join("、")}`];
  }
  if (typeof seated.seedShare === "string" && shares[seated.seat] !== seated.seedShare) {
    return [
      "share-unused",
      "シャッフルに自分のシェアが使われていません。席に着くのが期限に間に合わなかったか、サーバがシェアを捨てています。",
    ];
  }
  // 期限に遅れたことにしてシェアを捨てれば、サーバは並びを 2 通りから選べる。黙って「合う」とだけ出さない。
  const opponent = 1 - seated.seat;
  if (shares[opponent] === null && seated.seedShareCommits[opponent] !== null) {
    return [
      "opponent-share-unused",
      "シャッフルの値を検算しました。ただし相手のシェアは期限までに開かれず、並びはサーバと自分の値で決まりました。",
    ];
  }
  // 確かめたのは値の対応までである。その seed で対局したかは、記録を再生しないと分からない。
  return ["ok", "シャッフルの値を検算しました。seed は、対戦の前にコミットされた値から導けます。"];
}

async function deckToSubmit() {
  if (hasPendingText()) return null;
  if (deckEntries.length === 0) {
    showDeckStatus(["サンプルデッキで対戦します。"], "ok");
    return getJson("/api/sample-deck");
  }
  return validateBuiltDeck();
}

async function checkDeck() {
  if (hasPendingText()) return null;
  if (deckEntries.length === 0) {
    showDeckStatus(["デッキにカードがありません。"], "ng");
    return null;
  }
  return validateBuiltDeck();
}

async function validateBuiltDeck() {
  const deck = { cards: deckCards() };
  const outcome = await postJson("/api/deck/validate", deck);
  if (outcome.ok) return deck;
  showDeckStatus(outcome.errors ?? ["デッキが通りませんでした。"], "ng");
  return null;
}

/**
 * テキスト欄に、読み込んでいないリストが残っているか。
 *
 * 残したまま押されたら止める。組んだデッキだけを見て進めると、貼ったリストとは別のデッキ
 * （空ならサンプルデッキ）で対戦が始まる。黙って読み込むと、組んだデッキが黙って消える。
 */
function hasPendingText() {
  if ($("decklist").value.trim() === "") return false;
  $("decklist").closest("details").open = true;
  showDeckStatus(
    [
      "テキスト欄に読み込んでいないリストがあります。「読み込む」を押すか、テキストを消してください。",
    ],
    "ng",
  );
  return true;
}

function deckCards() {
  return deckEntries.flatMap((entry) => Array(entry.count).fill(entry.defId));
}

/**
 * 書いたテキストをサーバに解決させて、デッキと置き換える。名前から defId は一意に
 * 決まらないので、選べなかった行には候補をそのまま並べる。こちらでは推測しない。
 */
async function importText() {
  const text = $("decklist").value;
  if (text.trim() === "") {
    showDeckStatus(["テキストが空です。"], "ng");
    return;
  }
  const outcome = await postJson("/api/deck/resolve", { text });
  if (outcome.entries === undefined) {
    showDeckStatus(outcome.errors ?? ["読み込めませんでした。"], "ng", outcome.failures ?? []);
    return;
  }
  // 名前がすべて決まれば、枚数や構築の規則に通らなくても読み込む。足りない分は検索から足せばよい。
  const merged = [];
  for (const { defId, count } of outcome.entries) {
    const same = merged.find((entry) => entry.defId === defId);
    if (same === undefined) merged.push({ defId, count });
    else same.count += count;
  }
  setDeck(merged);
  $("decklist").value = "";
  if (outcome.ok) showDeckStatus([`デッキは ${deckCards().length} 枚で、規則を通ります。`], "ok");
  else showDeckStatus(outcome.errors, "ng");
}

/**
 * 公式のデッキコードで読み込んだデッキのうち、まだ決まっていないカードと、画面に出す理由。
 * `deck` はこちらが最後に置いたデッキで、ほかの操作で組み替わっていたら候補を押させない。
 * 押させると、読み込んだのとは別のデッキにカードが足される。
 */
let officialImport = null;

/**
 * 公式のデッキコードのデッキと置き換える。取り込めないカードがあっても、取り込めたぶんで
 * 置き換え、残りはどのカードかを公式のページにある名前で出す。
 */
async function importDeckCode() {
  const code = deckCodeOf($("deck-code").value);
  if (code === null) {
    showDeckStatus(["デッキコードか、公式サイトのデッキのページの URL を入れてください。"], "ng");
    return;
  }
  const before = deckEntries;
  showDeckStatus(["公式サイトからデッキを読んでいます。"], "");
  const official = await fetchOfficialDeck(code);
  if (official === null) {
    showDeckStatus([`デッキコード ${code} のデッキは公式サイトにありません。`], "ng");
    return;
  }
  const outcome = await postJson("/api/deck/official", { cards: official.cards });
  if (outcome.entries === undefined) {
    showDeckStatus(outcome.errors ?? ["読み込めませんでした。"], "ng");
    return;
  }
  // 待つあいだに組み替えられていたら、置き換えると組み替えたぶんが黙って消える。
  if (deckEntries !== before) {
    showDeckStatus(["読み込むあいだにデッキが変わったので、置き換えませんでした。"], "ng");
    return;
  }

  const nameOf = (cardId) => official.names[cardId] ?? `カード ID ${cardId}`;
  const missing = outcome.failures
    .filter((failure) => failure.kind !== "ambiguous")
    .map((failure) => `このサーバに無いカードです: ${nameOf(failure.cardId)} ${failure.count} 枚`);
  const pending = outcome.failures
    .filter((failure) => failure.kind === "ambiguous")
    .map((failure) => ({ ...failure, name: nameOf(failure.cardId), left: failure.count }));
  // 1 枚も決まらず選ぶものも無ければ、組んでいるデッキを空にしてまで置き換えない。
  if (outcome.entries.length === 0 && pending.length === 0) {
    officialImport = null;
    showDeckStatus(missing, "ng");
    return;
  }
  setDeck(outcome.entries);
  officialImport = { deck: deckEntries, missing, pending, errors: outcome.errors };
  showOfficialStatus();
}

/**
 * 決まっていないカードは、候補を 1 枚ずつ押させる。左右 2 枚で 1 つのスタジアムは公式サイトでは
 * 1 つのカードなので、枚数を左右にどう分けるかはデッキコードからは分からない。
 */
function showOfficialStatus() {
  const { missing, pending, errors } = officialImport;
  const open = pending.filter((group) => group.left > 0);
  const messages = [...missing];
  for (const group of open) {
    messages.push(
      `${group.name} は ${group.choices.length} 通りあります。あと ${group.left} 枚を選んでください。`,
    );
  }
  // 選び終わるまでの検査の結果は、選ぶ前のデッキのものなので出さない。
  if (errors === null) messages.push("デッキを確かめています。");
  else if (open.length === 0) messages.push(...errors);
  const ok = open.length === 0 && missing.length === 0 && errors?.length === 0;
  if (ok) messages.push(`デッキは ${deckCards().length} 枚で、規則を通ります。`);
  showDeckStatus(messages, ok ? "ok" : errors === null ? "" : "ng");
  for (const group of open) {
    const list = document.createElement("div");
    list.className = "choices";
    for (const choice of group.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${group.name}（${describeCard(choice) || choice.defId}）`;
      button.addEventListener("click", () => {
        pickOfficial(group, choice.defId).catch((error) =>
          showDeckStatus([`確かめられませんでした: ${error.message}`], "ng"),
        );
      });
      list.append(button);
    }
    $("deck-status").append(list);
  }
}

async function pickOfficial(group, defId) {
  if (officialImport?.deck !== deckEntries) {
    officialImport = null;
    showDeckStatus(["デッキが変わっています。もう一度デッキコードを読み込んでください。"], "ng");
    return;
  }
  if (group.left === 0) return;
  group.left -= 1;
  setDeck(withCount(deckEntries, defId, 1));
  const current = officialImport;
  current.deck = deckEntries;
  const done = current.pending.every((each) => each.left === 0);
  // 選び終えたら、検査の結果が届くまでは「確かめています」を出す。
  if (done) current.errors = null;
  showOfficialStatus();
  if (!done) return;
  const outcome = await postJson("/api/deck/validate", { cards: deckCards() });
  if (officialImport !== current || current.deck !== deckEntries) return;
  current.errors = outcome.errors ?? [];
  showOfficialStatus();
}

/** 入れた文字からデッキコードを取り出す。デッキのページの URL を貼られても読む。 */
function deckCodeOf(text) {
  const trimmed = text.trim();
  const code = /deckID[/=]([0-9A-Za-z-]+)/.exec(trimmed)?.[1] ?? trimmed;
  return /^[0-9A-Za-z]+(-[0-9A-Za-z]+)*$/.test(code) ? code : null;
}

/**
 * 公式のデッキ確認ページから、カード ID と枚数、カード名を読む。デッキが無ければ null。
 *
 * 枚数は `deck_*` の hidden input に「カード ID_枚数_…」を `-` でつないだ形で入っている。
 * 見つからないコードでも input は空で並ぶので、1 つも無ければページの形が変わったと読む。
 */
async function fetchOfficialDeck(code) {
  let response;
  try {
    response = await fetch(`${OFFICIAL_DECK_PAGE}${encodeURIComponent(code)}/`, {
      credentials: "omit",
    });
  } catch {
    throw new Error("公式サイトに繋がりませんでした");
  }
  if (!response.ok) throw new Error(`公式サイトが ${response.status} を返しました`);
  const html = await response.text();
  const fields = new DOMParser()
    .parseFromString(html, "text/html")
    .querySelectorAll('input[id^="deck_"]');
  if (fields.length === 0) throw new Error("公式サイトのページの形が変わっています");

  const cards = [];
  for (const field of fields) {
    for (const item of field.value.split("-").filter(Boolean)) {
      const match = /^([0-9]+)_([0-9]+)(_|$)/.exec(item);
      if (match === null) throw new Error("公式サイトのページの形が変わっています");
      cards.push({ cardId: match[1], count: Number(match[2]) });
    }
  }
  if (cards.length === 0) return null;

  // 名前はページのスクリプトの中にある。DOMParser はスクリプトを動かさないので、文字列として読む。
  const names = {};
  for (const [, cardId, quoted] of html.matchAll(
    /searchItemName\[([0-9]+)\]\s*=\s*'((?:[^'\\]|\\.)*)'/g,
  )) {
    names[cardId] = quoted.replace(/\\(.)/g, "$1");
  }
  return { cards, names };
}

/** 違反の一覧。曖昧な行だけは、選べる候補を押せる形で出す。 */
function showDeckStatus(messages, tone, failures = []) {
  const box = $("deck-status");
  box.innerHTML = "";
  box.className = `deck-status ${tone}`;
  for (const message of messages) {
    const line = document.createElement("p");
    line.textContent = message;
    box.append(line);
  }
  for (const failure of failures) {
    if (failure.kind !== "ambiguous") continue;
    const list = document.createElement("div");
    list.className = "choices";
    for (const choice of failure.choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${failure.name}（${describeCard(choice) || choice.defId}）`;
      button.addEventListener("click", () => pickChoice(failure.line, failure.name, choice.defId));
      list.append(button);
    }
    box.append(list);
  }
}

function describeCard(card) {
  if (card === undefined) return "";
  const parts = [];
  if (card.kind === "pokemon") {
    parts.push(
      [
        STAGES[card.stage] ?? card.stage,
        TYPES[card.type] ?? card.type,
        card.hp === undefined ? "" : `HP ${card.hp}`,
      ]
        .filter(Boolean)
        .join(" "),
    );
    if (card.abilities?.length > 0) parts.push(`特性 ${card.abilities.join("・")}`);
    if (card.attacks?.length > 0) parts.push(`ワザ ${card.attacks.join("・")}`);
  } else if (card.kind === "trainer") {
    parts.push(TRAINER_KINDS[card.trainerKind] ?? KINDS.trainer);
    if (card.stadiumHalf !== undefined) parts.push(`${HALVES[card.stadiumHalf]}半分`);
  } else {
    parts.push(card.basicEnergy ? "基本エネルギー" : (KINDS[card.kind] ?? card.kind));
  }
  if (card.aceSpec) parts.push("ACE SPEC");
  parts.push([card.set, card.number].filter(Boolean).join(" "));
  return parts.filter(Boolean).join(" / ");
}

/**
 * 選んだ候補の `defId` をその行に書き足す。`defId` を読めるのは「名前 枚数 defId」の形だけなので、
 * 「枚数 名前」で書かれた行も並べ替える。うしろに足すだけだと `defId` が名前の一部として読まれる。
 */
function pickChoice(line, name, defId) {
  const lines = $("decklist").value.split("\n");
  const index = line - 1;
  if (lines[index] === undefined) return;
  // サーバは全角の数字と空白を半角に直してから読む。返ってくる名前と比べるので、こちらも揃える。
  const tokens = lines[index]
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .trim()
    .split(/\s+/);
  const countFirst = /^[0-9]+$/.test(tokens[0]);
  const count = countFirst ? tokens[0] : tokens[tokens.length - 1];
  const written = (countFirst ? tokens.slice(1) : tokens.slice(0, -1)).join(" ");
  // 候補を出したあとにテキストを書き換えていたら、その行はもう別のカードかもしれない。
  if (written !== name) {
    showDeckStatus(["テキストが変わっています。もう一度「読み込む」を押してください。"], "ng");
    return;
  }
  lines[index] = `${name} ${count} ${defId}`;
  $("decklist").value = lines.join("\n");
  importText().catch((error) => showDeckStatus([`読み込めませんでした: ${error.message}`], "ng"));
}

/** 残したデッキを読む。形の崩れた値は捨てる。手で書き換えられることもある場所なので。 */
function loadDeck() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(DECK_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(saved)) return [];
  return saved
    .filter(
      (entry) =>
        typeof entry?.defId === "string" && Number.isInteger(entry.count) && entry.count > 0,
    )
    .map((entry) => ({ defId: entry.defId, count: Math.min(entry.count, DECK_SIZE) }));
}

function setDeck(entries) {
  const restore = focusedRowButton();
  deckEntries = entries;
  renderDeck();
  renderSearch();
  restore();
  // 残せなくても組むことはできる。投げると、画面と送る中身が食い違ったまま止まる。
  try {
    if (entries.length === 0) localStorage.removeItem(DECK_KEY);
    else localStorage.setItem(DECK_KEY, JSON.stringify(entries));
  } catch {}
}

function changeCount(defId, delta) {
  setDeck(withCount(deckEntries, defId, delta));
  // 前に出した検査の結果は、組み替えた時点で古くなる。
  showDeckStatus([], "");
}

function withCount(entries, defId, delta) {
  const next = entries
    .map((entry) => (entry.defId === defId ? { defId, count: entry.count + delta } : entry))
    .filter((entry) => entry.count > 0);
  if (delta > 0 && !entries.some((entry) => entry.defId === defId)) {
    next.push({ defId, count: delta });
  }
  return next;
}

/**
 * 押したボタンは描き直しで作り直されるので、フォーカスが外れる。キーボードで続けて押せるよう、
 * 描き直したあとで同じ行の同じボタンへ戻す関数を返す。
 */
function focusedRowButton() {
  const button = document.activeElement;
  const row = button?.closest?.(".card-row");
  const action = ["add", "remove"].find((name) => button?.classList.contains(name));
  if (row == null || action === undefined) return () => {};
  const list = row.parentElement.id;
  const { defId } = row.dataset;
  // 同じボタンが押せなくなっていたら（上限に届いた、行が消えた）、同じ行のもう片方か検索欄へ。
  return () => {
    const next = $(list)?.querySelector(`.card-row[data-def-id="${CSS.escape(defId)}"]`);
    const target = [...(next?.querySelectorAll("button") ?? [])]
      .filter((candidate) => !candidate.disabled)
      .sort(
        (a, b) => Number(!a.classList.contains(action)) - Number(!b.classList.contains(action)),
      )[0];
    (target ?? $("card-search")).focus();
  };
}

function canAdd(defId) {
  const card = cards[defId];
  if (card === undefined) return false;
  let total = 0;
  let sameName = 0;
  let aceSpecs = 0;
  for (const entry of deckEntries) {
    total += entry.count;
    if (cards[entry.defId]?.name === card.name) sameName += entry.count;
    if (cards[entry.defId]?.aceSpec === true) aceSpecs += entry.count;
  }
  return (
    total < DECK_SIZE &&
    (card.basicEnergy === true || sameName < SAME_NAME_LIMIT) &&
    (card.aceSpec !== true || aceSpecs < ACE_SPEC_LIMIT)
  );
}

function countInDeck(defId) {
  return deckEntries.find((entry) => entry.defId === defId)?.count ?? 0;
}

function renderDeck() {
  const total = deckEntries.reduce((sum, entry) => sum + entry.count, 0);
  const count = $("deck-count");
  count.textContent = total === 0 ? "デッキは空です。" : `${total} / ${DECK_SIZE} 枚`;
  count.classList.toggle("full", total === DECK_SIZE);

  const box = $("deck-cards");
  box.innerHTML = "";
  // 名前の表が届くまでは、defId しか出せないので並べない。
  if (Object.keys(cards).length === 0) {
    if (total > 0) box.append(noteLine("カードの一覧を読み込んでいます。"));
    return;
  }
  for (const kind of [...Object.keys(KINDS), null]) {
    const entries = deckEntries.filter((entry) =>
      kind === null ? !(cards[entry.defId]?.kind in KINDS) : cards[entry.defId]?.kind === kind,
    );
    if (entries.length === 0) continue;
    const heading = document.createElement("h3");
    const sum = entries.reduce((acc, entry) => acc + entry.count, 0);
    heading.textContent = `${kind === null ? "そのほか" : KINDS[kind]} ${sum} 枚`;
    box.append(heading);
    for (const entry of entries) {
      const row = cardRow(entry.defId);
      const minus = rowButton("−", () => changeCount(entry.defId, -1));
      minus.classList.add("remove");
      const plus = rowButton("＋", () => changeCount(entry.defId, 1));
      plus.classList.add("add");
      plus.disabled = !canAdd(entry.defId);
      const shown = document.createElement("span");
      shown.className = "card-count";
      shown.textContent = String(entry.count);
      row.append(minus, shown, plus);
      box.append(row);
    }
  }
}

/**
 * 検索欄に打った語をすべて含むカードを並べる。名前の前方一致を先に出す。
 *
 * 名前だけでは絞れない。同じ名前のカードが上限より多いこともあるので、ワザや特性の名前、
 * 収録でも当たるようにして、空白で区切って打ち足せるようにする。
 */
function renderSearch() {
  const box = $("card-results");
  box.innerHTML = "";
  const words = searchKey($("card-search").value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  if (Object.keys(cards).length === 0) {
    box.append(noteLine("カードの一覧を読み込んでいます。"));
    return;
  }
  const first = words[0];
  const matched = searchRows().filter(({ text }) => words.every((word) => text.includes(word)));
  const found = [
    ...matched.filter(({ name }) => name.startsWith(first)),
    ...matched.filter(({ name }) => !name.startsWith(first)),
  ];
  if (found.length === 0) box.append(noteLine("見つかりません。"));
  for (const { defId } of found.slice(0, SEARCH_LIMIT)) {
    const row = cardRow(defId);
    const inDeck = countInDeck(defId);
    const shown = document.createElement("span");
    shown.className = "card-count";
    shown.textContent = inDeck === 0 ? "" : `${inDeck} 枚`;
    const add = rowButton("追加", () => changeCount(defId, 1));
    add.classList.add("add");
    add.disabled = !canAdd(defId);
    row.append(shown, add);
    box.append(row);
  }
  if (found.length > SEARCH_LIMIT) {
    box.append(
      noteLine(
        `ほかに ${found.length - SEARCH_LIMIT} 件あります。ワザの名前などを空白のあとに打ち足すと絞れます。`,
      ),
    );
  }
}

/** 検索で比べる形と名前の順を、表ごとに 1 度だけ作る。打つたび、押すたびに全部を作り直さない。 */
function searchRows() {
  if (searchIndex?.from === cards) return searchIndex.rows;
  const collator = new Intl.Collator("ja");
  const rows = Object.entries(cards).map(([defId, card]) => ({
    defId,
    card,
    name: searchKey(card.name),
    text: searchKey(
      [card.name, ...(card.attacks ?? []), ...(card.abilities ?? []), card.set, card.number].join(
        " ",
      ),
    ),
  }));
  rows.sort((a, b) => collator.compare(a.card.name, b.card.name) || (a.defId < b.defId ? -1 : 1));
  searchIndex = { from: cards, rows };
  return rows;
}

/**
 * 検索で比べる形。ひらがなで打ってもカタカナの名前に当たるようにし、全角と半角の違いも潰す。
 */
function searchKey(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u3041-\u3096]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
}

function cardRow(defId) {
  const card = cards[defId];
  const row = document.createElement("div");
  row.className = "card-row";
  row.dataset.defId = defId;
  const label = document.createElement("span");
  label.className = "card-label";
  const name = document.createElement("strong");
  name.textContent = card?.name ?? defId;
  const detail = document.createElement("span");
  detail.className = "card-detail";
  detail.textContent = describeCard(card);
  label.append(name, " ", detail);
  // 画像が無いときの小さな面は名前も読めないので、画像を出すときだけ並べる。
  if (imageUrl(defId) !== null) {
    const thumbnail = cardFace(defId);
    thumbnail.classList.add("thumb");
    row.append(thumbnail);
  }
  row.append(label);
  return row;
}

function rowButton(text, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function noteLine(text) {
  const line = document.createElement("p");
  line.className = "note";
  line.textContent = text;
  return line;
}

/**
 * 相手が見つかるまで取りに行く。
 *
 * チケットが降りていたら待つのをやめる。 同じプレイヤーが別のタブから入ると古いチケットは降りる。
 * それを「まだ待っている」と読むと、このタブは永久に問い合わせ続けることになる。
 */
async function waitForOpponent(ticket, seedShare) {
  for (;;) {
    let claimed = null;
    try {
      claimed = await getJson(`/api/claim?ticket=${encodeURIComponent(ticket)}`);
      setStatus("相手を待っています");
    } catch {
      /**
       * **1 度取りに行けなかっただけで待つのをやめない。** 席はもう取れているかもしれず、
       * やめるとその対戦に座らないまま時間切れで負ける。チケットは何度でも使えるので、
       * 取り直せばよい。本当に降りていれば、繋がった時点で `dropped` が返る。
       */
      setStatus("相手を待っています（つながりが悪いので取り直しています）");
    }
    if (claimed?.kind === "seated") {
      openMatch({ ...claimed.seat, seedShare });
      return;
    }
    if (claimed?.kind === "finished") {
      // 席に着く前に終わっている。指していなくても記録には残り、レーティングも動いている。
      setStatus("この対戦は、席に着く前に終わりました。「一覧を出す」から読み返せます。");
      refreshAccount().catch(() => {});
      return;
    }
    if (claimed?.kind === "dropped") {
      setStatus("別のタブから入り直したので、このタブは待つのをやめました。");
      return;
    }
    /**
     * **知らない答えで待ち続けない。** 「まだ待っている」以外は、こちらが知らない形でも
     * 待つのをやめる。入れ替えのあとに古いタブが新しい答えを受け取ることがあり、
     * 待ち続けると `dropped` を足す前と同じ「永久に問い合わせ続ける」に戻る。
     */
    if (claimed !== null && claimed.kind !== "waiting") {
      setStatus("受付の記録が無くなりました。もう一度「対戦をさがす」を押してください。");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function openMatch(seated) {
  if (seatLink !== null) {
    seatLink.retry.stop();
    socket?.close();
  }
  seat = seated.seat;
  seatedNow = seated;
  rememberSeat(seated);
  setStatus("");
  showConnection(null);
  $("join").hidden = true;
  $("table").hidden = false;
  delete $("table").dataset.ended;
  // 両者がシェアを開くまで局面は届かない。
  $("clock").textContent = "相手が席に着くのを待っています";
  $("shuffle-check").hidden = true;

  const link = {
    seated,
    /** 一度でも `sync` か `pending` が届いたか。届いていれば、サーバはこの座席を知っている。 */
    known: false,
    ended: false,
    replaced: false,
    retry: null,
  };
  link.retry = reconnector(() => connectSeat(link));
  seatLink = link;
  connectSeat(link);
}

function connectSeat(link) {
  const query = [`seatToken=${encodeURIComponent(link.seated.seatToken)}`];
  // 繋ぎ直しでも付ける。シェアを開く前に切れていれば、ここで開くことになる。
  if (typeof link.seated.seedShare === "string") query.push(`seedShare=${link.seated.seedShare}`);
  const ws = new WebSocket(socketUrl(query.join("&")));
  socket = ws;
  let code = null;
  let lost = false;
  /** この接続で `sync` か `pending` を受けたか。 */
  let joined = false;
  keepAlive(ws, onLost);
  ws.addEventListener("message", (event) => {
    if (lost || seatLink !== link) return;
    const message = JSON.parse(event.data);
    if ((message.t === "sync" || message.t === "pending") && !joined) {
      joined = true;
      link.known = true;
      link.retry.connected();
      showConnection(null);
      seatChannel?.postMessage({ seatToken: link.seated.seatToken });
    }
    if (message.t === "ended") link.ended = true;
    if (message.t === "error" && typeof message.code === "string") code = message.code;
    receive(message);
  });
  ws.addEventListener("close", onLost);

  function onLost() {
    if (lost || seatLink !== link || link.replaced) return;
    lost = true;
    if (link.ended) {
      link.retry.stop();
      return;
    }
    disableMoves();
    /**
     * 座席を捨てるのは、サーバが「この座席を知らない」と言ったときだけにする（仕様 3.3 節）。
     * 何も届かずに閉じた接続は、回線が切れただけのこともある。
     */
    if (code === "seat-not-found") {
      // 別のタブが新しい対戦の座席を置いていれば、それは消さない。
      if (storedSeat()?.seatToken === link.seated.seatToken) forgetSeat();
      backToJoin("指していた対戦は、もう終わっています。");
      return;
    }
    if (code === "seat-replaced") {
      replaceSeatLink(link);
      return;
    }
    if (!link.known) {
      // 盤面の画面に留めると、繋がらない状態が続いたときに対戦を始める画面へ出られない。
      backToJoin("サーバへ繋がりませんでした。読み込み直すと、指していた対戦へ繋ぎ直します。");
      return;
    }
    const attempt = link.retry.schedule();
    showConnection("reconnecting", `接続が切れました。繋ぎ直しています（${attempt} 回目）`);
  }
}

/** この座席は別のタブが指している。繋ぎ直すと、そちらの接続を追い出す。 */
function replaceSeatLink(link) {
  link.replaced = true;
  link.retry.stop();
  socket?.close();
  disableMoves();
  showConnection(
    "replaced",
    "この対戦を別のタブで開いたので、ここでは止めました。読み込み直すと、こちらで続けられます。",
  );
}

/**
 * 切れた接続を張り直す。間隔の決め方は仕様 3.3 節。
 * 回線が戻ったとブラウザが知らせたら、待たずに繋ぐ。
 */
function reconnector(connect) {
  let retries = 0;
  let timer = null;
  let connectedAt = null;
  const now = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    connect();
  };
  window.addEventListener("online", now);
  return {
    schedule() {
      // 繋がってすぐ切れる状態が続くときは、間隔を延ばし続ける。
      if (connectedAt !== null && Date.now() - connectedAt >= 30_000) retries = 0;
      connectedAt = null;
      const delay = Math.min(30_000, 1_000 * 2 ** retries) * (0.5 + Math.random() / 2);
      retries += 1;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      return retries;
    },
    connected() {
      connectedAt = Date.now();
    },
    stop() {
      clearTimeout(timer);
      timer = null;
      window.removeEventListener("online", now);
    },
  };
}

function showConnection(state, text = "") {
  const shown = $("connection");
  shown.hidden = state === null;
  shown.dataset.state = state ?? "";
  shown.textContent = text;
  // 切れているあいだの投了は届かない。押せたように見せない。
  $("concede-button").disabled = state !== null;
}

/** 切れているあいだの手は届かない。押せたように見せない。 */
function disableMoves() {
  for (const button of $("moves").querySelectorAll("button")) button.disabled = true;
}

/** マッチングの画面へ戻す。座席を失ったときと、座席へ繋がらなかったときに通る。 */
function backToJoin(text) {
  seatLink?.retry.stop();
  seatLink = null;
  socket = null;
  seat = null;
  $("table").hidden = true;
  $("join").hidden = false;
  // 対戦の結果をマッチングの画面に重ねたままにしない。
  $("results").replaceChildren();
  setStatus(text);
}

function rememberSeat(seated) {
  localStorage.setItem(SEAT_KEY, JSON.stringify(seated));
}

function forgetSeat() {
  localStorage.removeItem(SEAT_KEY);
}

/** 覚えている座席。読めない値が入っていたら捨てる。 */
function storedSeat() {
  const raw = localStorage.getItem(SEAT_KEY);
  if (raw === null) return null;
  let seated = null;
  try {
    seated = JSON.parse(raw);
  } catch {
    forgetSeat();
    return null;
  }
  // 座席トークンが無ければ繋ぎようがない。座席の番号は時計と手札の向きに使う。
  if (typeof seated?.seatToken !== "string" || (seated.seat !== 0 && seated.seat !== 1)) {
    forgetSeat();
    return null;
  }
  return seated;
}

function receive(message) {
  switch (message.t) {
    case "sync":
    case "delta": {
      if (message.t === "sync") $("watch-link").value = watchUrl(message.spectatorToken);
      stateVersion = message.stateVersion;
      const events = message.events ?? [];
      const results = describeResults(events, [message.view, lastView], seatName);
      logEvents(events, results);
      renderView(message.view);
      if (message.t === "sync") showFirstPlayer(message.matchId, message.firstPlayer, message.view);
      showResults(results, $("table"));
      renderClock(message.clock);
      setupDraft.sent = false;
      renderMoves(message.legalMoves, true, message.setup);
      // delta が運ぶのは準備のあいだだけで、無ければ前のものから変わっていない。
      renderMulligans(message.mulligans ?? lastMulligans);
      return;
    }
    case "ended": {
      $("table").dataset.ended = "";
      // 終わった座席へは繋ぎ直せない。覚えたままだと、次に開いたときに繋ぎに行って断られる。
      forgetSeat();
      // 観戦トークンも終わった対戦では通らない。残すと、渡された人が開いても入れない。
      $("watch-link").value = "";
      renderView(message.view);
      renderMoves(null, false);
      // 次の対戦で見せた手札を、この対戦のものと比べて「増えた」と読まない。
      lastMulligans = [];
      const text = describeEnd(message);
      addEvent(text);
      showResult({ text, tone: endTone(message.matchResult) });
      $("clock").textContent = "対戦は終わりました";
      void showShuffleCheck(seatedNow, message);
      // 決着でレーティングが動く。開いた時点の値のまま置かない。
      refreshAccount().catch(() => {});
      return;
    }
    case "reject": {
      // 古い画面から押したときは、サーバが正しい局面を送り直してくる。
      const text = `手が通りませんでした（${REJECT_REASONS[message.reason] ?? message.reason}）`;
      addEvent(text);
      showResult({ text, tone: "attention" });
      return;
    }
    case "error":
      addEvent(message.message);
      showResult({ text: message.message, tone: "attention" });
      return;
    default:
      return;
  }
}

function describeEnd(message) {
  const result = message.matchResult;
  const mine = result.winner === seat ? "勝ち" : "負け";
  if (result.kind === "concede") return `投了により ${mine}`;
  if (result.kind === "timeout") return `時間切れにより ${mine}`;
  if (result.winner === null) return "引き分け";
  const reason = message.outcome?.reason;
  return `${mine}（${WIN_REASONS[reason] ?? reason ?? ""}）`;
}

function endTone(result) {
  if (result.winner === null) return "neutral";
  return result.winner === seat ? "positive" : "negative";
}

function renderView(view) {
  lastView = view;
  renderSide($("opponent"), view.opponent, true);
  renderStadium($("stadium"), view.stadium);
  renderSide($("self"), view.self, false);
}

/** 子に渡した文字列は文字として入り、HTML としては読まない。 */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function imageUrl(defId) {
  const cardID = cards[defId]?.cardID;
  if (!cardImages || typeof cardID !== "string") return null;
  const url = `/api/card-image/${cardID}`;
  return failedImages.has(url) ? null : url;
}

/**
 * カード 1 枚。名前と種類の面を敷き、画像を出すときはその上に重ねる。
 * 画像が読めなければ外して、下の面をそのまま見せる。
 */
function cardFace(defId) {
  const card = cards[defId];
  const face = el("div", "card");
  face.dataset.defId = defId;
  face.dataset.kind = card?.kind ?? "";
  if (card?.type !== undefined) face.dataset.type = card.type;
  face.append(el("span", "card-name", card?.name ?? defId));
  const sub =
    card?.hp !== undefined
      ? `HP ${card.hp}`
      : (TRAINER_KINDS[card?.trainerKind] ?? KINDS[card?.kind] ?? "");
  face.append(el("span", "card-sub", sub));
  // 読み上げでは、マウスで出るプレビューの代わりにここを読む。
  if (card !== undefined) face.append(el("span", "visually-hidden", describeCard(card)));
  const src = imageUrl(defId);
  if (src !== null) {
    const image = document.createElement("img");
    // 名前は下の面が持っている。読み上げで二重にしない。
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      failedImages.add(src);
      image.remove();
    });
    image.src = src;
    face.append(image);
  }
  return face;
}

function cardBack() {
  return el("div", "card back");
}

function emptySlot() {
  return el("div", "card empty");
}

/**
 * 押すと大きく出す。場のポケモンなら、進化の下のカードとついているカードもまとめて出す。
 * 盤面は描き直しで作り直されるので、出す中身は要素ごとに持たせる。
 */
const zoomTargets = new WeakMap();

function zoomable(element, title, defIds) {
  zoomTargets.set(element, { title, defIds });
  element.classList.add("zoomable");
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  return element;
}

function openZoom({ title, defIds }) {
  $("card-zoom-title").textContent = title;
  $("card-zoom-cards").replaceChildren(
    ...defIds.map((defId) =>
      el("figure", "", cardFace(defId), el("figcaption", "", ...cardCaption(defId))),
    ),
  );
  if (!$("card-zoom").open) $("card-zoom").showModal();
}

function cardCaption(defId) {
  return [el("strong", "", nameOf(defId)), " ", describeCard(cards[defId])];
}

// 枠の外（背景）を押しても閉じる。中身は内側の要素が覆っているので、dialog そのものに当たるのは背景だけである。
$("card-zoom").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) $("card-zoom").close();
});

document.addEventListener("click", (event) => {
  const target = event.target.closest?.(".zoomable");
  if (target != null && zoomTargets.has(target)) openZoom(zoomTargets.get(target));
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target;
  if (!target.classList?.contains("zoomable") || !zoomTargets.has(target)) return;
  event.preventDefault();
  openZoom(zoomTargets.get(target));
});

/**
 * マウスを載せている間（タッチ端末では長押しの間）、カードを大きく出す。印刷の小さな文字は
 * 盤面の大きさでは読めない。押して開く拡大と違ってマウスの操作を受けないので、手を指す邪魔をしない。
 */
const LONG_PRESS_MS = 400;
/** 長押しの途中で指がこれより動いたら、スクロールのつもりとみなしてやめる。 */
const LONG_PRESS_SLOP_PX = 10;
const PREVIEW_MARGIN_PX = 8;
const PREVIEW_GAP_PX = 12;

let previewTarget = null;
let previewPointer = "mouse";
let longPress = null;
// 長押しで読んで指を離すと、そのクリックも届いて拡大が開いてしまう。
let swallowClick = false;
let lastMouse = null;
// 盤面は相手の手でも描き直され、載せていたカードが消える。マウスなら下に来たカードへ移り、
// 閉じてから開き直す一瞬のちらつきを出さない。指で押している最中なら、押したカードはもう無いので閉じる。
const previewWatch = new MutationObserver(() => {
  if (previewTarget === null || previewTarget.isConnected) return;
  const under =
    longPress === null && lastMouse !== null
      ? document.elementFromPoint(lastMouse.x, lastMouse.y)
      : null;
  const card = previewable(under);
  if (card === null) hidePreview();
  else showPreview(card, "mouse");
});

function previewable(target) {
  const card = target?.closest?.(".card[data-def-id]");
  // 開いた拡大の中のカードは、もう大きい。
  if (card == null || card.closest("dialog, #card-preview") !== null) return null;
  return card;
}

function showPreview(card, pointerType) {
  if (card === previewTarget) return;
  const defId = card.dataset.defId;
  const preview = $("card-preview");
  const src = imageUrl(defId);
  // 同じカードなら前に作った中身をそのまま使う。カードの一覧が届く前に作った中身や、
  // 読めなくなった画像を残さないよう、その 2 つも鍵に入れる。
  const key = `${defId}\n${cards[defId] !== undefined}\n${src}`;
  if (preview.dataset.key !== key) {
    preview.dataset.key = key;
    // 画像があれば効果まで画像で読める。無いときだけ、名前の面に種類とワザを書き添える。
    preview.replaceChildren(
      cardFace(defId),
      ...(src === null ? [el("p", "", ...cardCaption(defId))] : []),
    );
  }
  previewTarget = card;
  previewPointer = pointerType;
  previewWatch.observe(document.body, { childList: true, subtree: true });
  preview.hidden = false;
  placePreview();
}

function hidePreview() {
  previewTarget = null;
  previewWatch.disconnect();
  $("card-preview").hidden = true;
}

/**
 * カードの横に出し、入らなければ上下、それも無理なら画面の中央に重ねる。
 * 指で押しているときは、指と手のひらが下と横を隠すので上を先に試す。
 * 画面の幅は `clientWidth` で測る。`innerWidth` はスクロールバーの下まで含む。
 */
function placePreview() {
  const preview = $("card-preview");
  const rect = previewTarget.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const width = preview.offsetWidth;
  const height = preview.offsetHeight;
  const maxX = clientWidth - width - PREVIEW_MARGIN_PX;
  const maxY = clientHeight - height - PREVIEW_MARGIN_PX;
  const clamp = (value, max) => Math.max(PREVIEW_MARGIN_PX, Math.min(value, max));
  const beside = clamp(rect.top + rect.height / 2 - height / 2, maxY);
  const across = clamp(rect.left + rect.width / 2 - width / 2, maxX);
  const right = { x: rect.right + PREVIEW_GAP_PX, y: beside };
  const left = { x: rect.left - PREVIEW_GAP_PX - width, y: beside };
  const above = { x: across, y: rect.top - PREVIEW_GAP_PX - height };
  const below = { x: across, y: rect.bottom + PREVIEW_GAP_PX };
  const order =
    previewPointer === "touch" ? [above, right, left, below] : [right, left, above, below];
  const spot = order.find(
    ({ x, y }) => x >= PREVIEW_MARGIN_PX && x <= maxX && y >= PREVIEW_MARGIN_PX && y <= maxY,
  ) ?? { x: clamp((clientWidth - width) / 2, maxX), y: clamp((clientHeight - height) / 2, maxY) };
  preview.style.left = `${spot.x}px`;
  preview.style.top = `${spot.y}px`;
}

document.addEventListener("pointerover", (event) => {
  if (event.pointerType === "touch") return;
  const card = previewable(event.target);
  if (card !== null) showPreview(card, event.pointerType);
});
document.addEventListener("pointerout", (event) => {
  if (event.pointerType === "touch" || previewTarget === null) return;
  if (previewTarget.contains(event.relatedTarget)) return;
  hidePreview();
});
document.addEventListener("pointerdown", (event) => {
  swallowClick = false;
  if (event.pointerType !== "touch") return;
  if (longPress !== null) endLongPress();
  const card = previewable(event.target);
  if (card === null) return;
  const timer = setTimeout(() => {
    if (!card.isConnected) return;
    showPreview(card, "touch");
    swallowClick = true;
  }, LONG_PRESS_MS);
  longPress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer };
});
document.addEventListener("pointermove", (event) => {
  if (event.pointerType !== "touch") lastMouse = { x: event.clientX, y: event.clientY };
  if (longPress?.pointerId !== event.pointerId) return;
  const moved = Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y);
  if (moved > LONG_PRESS_SLOP_PX) endLongPress();
});
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, (event) => {
    if (longPress?.pointerId === event.pointerId) endLongPress();
  });
}
document.addEventListener(
  "click",
  (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.preventDefault();
    event.stopPropagation();
  },
  { capture: true },
);
// 長押しで出る画像の保存や選択のメニューが、プレビューの上に重なる。
document.addEventListener("contextmenu", (event) => {
  if (longPress !== null) event.preventDefault();
});
// 一覧やページが送られるとカードは動くが、マウスの下が同じカードのままなら置き直す合図が来ない。
document.addEventListener(
  "scroll",
  (event) => {
    if (previewTarget !== null && event.target.contains?.(previewTarget)) placePreview();
  },
  { capture: true, passive: true },
);

function endLongPress() {
  clearTimeout(longPress.timer);
  longPress = null;
  hidePreview();
}

/** 盤面のゾーン。`count` は山札やトラッシュのように、枚数を読むゾーンでだけ渡す。 */
function zone(name, label, count, ...children) {
  const caption = count === null ? label : `${label} ${count}`;
  const box = el("div", `zone ${name}`, ...children, el("span", "zone-label", caption));
  box.dataset.zone = name;
  if (count !== null) box.dataset.count = String(count);
  return box;
}

/**
 * 1 人ぶんの場。`mirrored` は向かいに座る側で、卓を挟んで見たとおりに上下と左右を返す。
 * 手札の中身が見えない側は、射影が `hand` の代わりに `handCount` を持っている。
 */
function renderSide(container, side, mirrored) {
  const faceUp = new Map(side.faceUpPrizes.map((prize) => [prize.index, prize.defId]));
  const prizes = Array.from({ length: side.prizeCount }, (_, index) => {
    const defId = faceUp.get(index);
    return defId === undefined ? cardBack() : zoomable(cardFace(defId), "サイド", [defId]);
  });

  // ベンチの枠の数はスタジアムで変わり、射影には載っていない。空いた枠は描かない。
  const benched = side.bench.filter((pokemon) => pokemon !== null);
  const bench = benched.length === 0 ? [emptySlot()] : benched.map(pokemonSlot);
  const field = el(
    "div",
    "field",
    zone("active", "バトル場", null, pokemonSlot(side.active)),
    zone("bench", "ベンチ", null, ...bench),
  );

  const piles = el(
    "div",
    "piles",
    zone("deck", "山札", side.deckCount, side.deckCount > 0 ? cardBack() : emptySlot()),
    pileZone("discard", "トラッシュ", side.discard),
  );
  const prizeSide = el(
    "div",
    "prize-side",
    zone("prizes", "サイド", side.prizeCount, el("div", "prize-grid", ...prizes)),
  );
  if (side.lostZone.length > 0) {
    prizeSide.prepend(pileZone("lost", "ロストゾーン", side.lostZone));
  }

  const mat = el("div", mirrored ? "mat mirrored" : "mat", prizeSide, field, piles);

  const held =
    side.hand === undefined
      ? Array.from({ length: side.handCount }, cardBack)
      : side.hand.map((card) => zoomable(cardFace(card.defId), "手札", [card.defId]));
  const hand = zone("hand", "手札", held.length, ...held);
  // 入りきらない枚数のときに、どれだけ重ねるかを CSS が決める。
  hand.style.setProperty("--cards", String(held.length));
  container.replaceChildren(...(mirrored ? [hand, mat] : [mat, hand]));
}

function pileZone(name, label, pile) {
  if (pile.length === 0) return zone(name, label, 0, emptySlot());
  const top = cardFace(pile[pile.length - 1].defId);
  const box = zone(name, label, pile.length, top);
  return zoomable(box, label, pile.map((card) => card.defId).reverse());
}

/**
 * 場のポケモン 1 匹。ついているカードは下からのぞかせ、ダメージと特殊状態は印で出す。
 * ねむり・マヒ・こんらんは、卓で向きを変えて示すのに合わせてカードを傾ける。
 */
function pokemonSlot(pokemon) {
  if (pokemon === null) return emptySlot();
  if (pokemon.concealed === true) return cardBack();
  const top = pokemon.stack[pokemon.stack.length - 1];
  const face = cardFace(top.defId);
  const posture = pokemon.conditions.find((condition) =>
    ["asleep", "paralyzed", "confused"].includes(condition.kind),
  );
  if (posture !== undefined) face.dataset.posture = posture.kind;

  const marks = el("div", "marks");
  if (pokemon.damage > 0) marks.append(el("span", "damage", String(pokemon.damage)));
  for (const condition of pokemon.conditions) {
    marks.append(el("span", "condition", conditionName(condition)));
  }

  const body = el("div", "pokemon", face, marks);
  if (pokemon.attached.length > 0) {
    body.append(el("div", "attached", ...pokemon.attached.map((card) => cardFace(card.defId))));
  }
  body.dataset.inPlayId = pokemon.inPlayId;
  body.dataset.damage = String(pokemon.damage);
  const name = cards[top.defId]?.name ?? top.defId;
  return zoomable(body, name, [
    ...pokemon.stack.map((card) => card.defId).reverse(),
    ...pokemon.attached.map((card) => card.defId),
  ]);
}

function renderStadium(container, stadium) {
  const shown =
    stadium === null
      ? [emptySlot()]
      : "instanceId" in stadium
        ? [zoomable(cardFace(stadium.defId), "スタジアム", [stadium.defId])]
        : [stadium.left, stadium.right].map((card) =>
            zoomable(cardFace(card.defId), "スタジアム", [card.defId]),
          );
  const box = zone("stadium", "スタジアム", null, ...shown);
  container.replaceChildren(box);
}

function renderClock(clock) {
  const mine = Math.round(clock.bankMs[seat] / 1000);
  const theirs = Math.round(clock.bankMs[1 - seat] / 1000);
  const turn = clock.toMove === seat ? "あなたの番です" : "相手が考えています";
  const remaining = moveRemainingText(clock);
  $("clock").textContent = `${turn}${remaining} ／ 持ち時間 自分 ${mine} 秒・相手 ${theirs} 秒`;
}

/**
 * `playing` が偽なら対戦は終わっていて、待ちも選ぶものも無い。
 * `setup` はサーバが送る準備の状態で、あるあいだは同じ選択を 1 手ずつ指すボタンを並べない。
 */
function renderMoves(moves, playing = true, setup = null) {
  lastMoves = { moves, playing, setup };
  const prompt = $("move-prompt");
  prompt.textContent = playing ? promptText(lastView, moves !== null, setup) : "";
  prompt.hidden = prompt.textContent === "";
  renderSetupForm(playing && setup?.kind === "choose" ? setup : null);
  const container = $("moves");
  container.innerHTML = "";
  if (playing && setup !== null) return;
  if (moves === null) {
    // 準備の待ちは `move-prompt` が伝える。「相手の番」と出すと、番が相手へ移ったと読まれる。
    if (playing && lastView?.phase !== "setup") container.append(waitingNote(lastView));
    return;
  }
  const shown = foldMoves(moves, lastView);
  // 畳んだときだけ、見せた手の位置を添える。記録で、見せなかった手と選ばなかった手を分けるため（6.2 節）。
  const offered = shown.length === moves.length ? {} : { offered: shown.map(({ index }) => index) };
  for (const { move } of shown) {
    const button = document.createElement("button");
    button.textContent = describeMove(move);
    button.addEventListener("click", () => send({ t: "move", stateVersion, move, ...offered }));
    aimAt(button, moveTargets(move));
    container.append(button);
  }
}

/**
 * 人から見て同じ手を 1 つに畳み、残した手と `legalMoves` での位置を返す。
 *
 * エンジンが畳むのは手札の同じカードだけで、選択の候補（トラッシュするエネルギーなど）は
 * 1 枚ずつ並ぶ。同じ場所にある同じカードはどれを選んでも同じなので、場所と `defId` で見分ける。
 * 場所の分からないカードは畳まない。
 */
function foldMoves(moves, view) {
  const seen = new Set();
  const shown = [];
  moves.forEach((move, index) => {
    const key = JSON.stringify(move, (field, value) =>
      CARD_FIELDS.has(field) ? (cardKey(value, view) ?? value) : value,
    );
    if (seen.has(key)) return;
    seen.add(key);
    shown.push({ move, index });
  });
  return shown;
}

/** 手と答えのうち、カードのインスタンス ID を運ぶ欄。 */
const CARD_FIELDS = new Set(["cardInstanceId", "right", "left", "card"]);

function cardKey(instanceId, view) {
  const found = locateCard(instanceId, view);
  return found === null ? null : `${found.key} ${found.defId}`;
}

/** 手が狙う場のポケモン。ボタンにマウスを載せるか選ぶと、盤面のそのポケモンを囲む。 */
function moveTargets(move) {
  const answer = move.type === "AnswerChoice" ? move.answer : {};
  return [move.target, move.to, move.source, answer.target].filter((id) => typeof id === "string");
}

function aimAt(button, inPlayIds) {
  if (inPlayIds.length === 0) return;
  const mark = (on) => {
    for (const id of inPlayIds) {
      $("table")
        .querySelector(`.pokemon[data-in-play-id="${CSS.escape(id)}"]`)
        ?.classList.toggle("aimed", on);
    }
  };
  for (const type of ["pointerenter", "focus"]) button.addEventListener(type, () => mark(true));
  for (const type of ["pointerleave", "blur"]) button.addEventListener(type, () => mark(false));
}

/**
 * 手番のプレイヤーでなくても、選択を持てば手を持つ（きぜつしたあとにバトル場へ出すポケモンなど）。
 * 自分の番の途中で相手が選んでいるのを「相手の番」と出すと、番が移ったと読まれる。
 */
function waitingNote(view) {
  const ownTurn = view?.turnPlayer === view?.viewer;
  const note = el(
    "p",
    "waiting",
    ownTurn ? "相手が選んでいます。あなたの番は続きます" : "相手の番です",
  );
  note.dataset.state = ownTurn ? "their-choice" : "their-turn";
  return note;
}

/**
 * 対戦準備のバトル場とベンチを選ぶ。選んだものは「準備を終える」で 1 度に送る。
 *
 * エンジンは準備を 1 人ずつの選択に並べて進めるが、サーバは番の来ていない座席の答えも
 * 預かる（仕様 2.4 節）。1 つずつ送る形にすると、相手の番を待つたびに止まる。
 */
function renderSetupForm(offer) {
  $("setup").hidden = offer === null;
  if (offer === null) {
    setupDraft = { active: null, bench: [], sent: false };
    return;
  }
  if (!offer.active.includes(setupDraft.active)) setupDraft.active = null;
  setupDraft.bench = setupDraft.bench
    .filter((id) => offer.bench.includes(id) && id !== setupDraft.active)
    .slice(0, offer.benchSlots);

  const redraw = () => renderSetupForm(offer);
  $("setup-active").replaceChildren(
    ...offer.active.map((id) =>
      toggleButton(id, setupDraft.active === id, () => {
        setupDraft.active = setupDraft.active === id ? null : id;
        redraw();
      }),
    ),
  );
  const full = setupDraft.bench.length >= offer.benchSlots;
  $("setup-bench").replaceChildren(
    ...offer.bench
      .filter((id) => id !== setupDraft.active)
      .map((id) => {
        const chosen = setupDraft.bench.includes(id);
        const button = toggleButton(id, chosen, () => {
          setupDraft.bench = chosen
            ? setupDraft.bench.filter((each) => each !== id)
            : [...setupDraft.bench, id];
          redraw();
        });
        button.disabled = !chosen && full;
        return button;
      }),
  );
  $("setup-submit").disabled = setupDraft.active === null || setupDraft.sent;
}

/**
 * 引き直すときに見せた手札を、見せた順に並べる。準備のあいだに増えたら開き、対戦が始まったら畳む。
 * 相手が引き直したことは、相手に番が回る前に起きるので、できごとの欄だけでは見落とす。
 * それ以外の局面では開け閉めしない。プレイヤーが開いた欄を、次の局面で閉じてしまう。
 */
function renderMulligans(mulligans) {
  const grew = mulligans.length > lastMulligans.length;
  lastMulligans = mulligans;
  const inSetup = lastView?.phase === "setup";
  const details = $("mulligans");
  details.hidden = mulligans.length === 0;
  if (grew && inSetup) details.open = true;
  if (mulligansInSetup && !inSetup) details.open = false;
  mulligansInSetup = inSetup;
  const counts = [0, 0];
  $("mulligan-list").replaceChildren(
    ...mulligans.map(({ player, cards: shown }) => {
      counts[player] += 1;
      const own = player === lastView?.viewer;
      const row = el("div", "mulligan", `${own ? "自分" : "相手"}（${counts[player]} 回目）`);
      row.dataset.side = own ? "self" : "opponent";
      const hand = el("div", "zone hand");
      hand.append(...shown.map((defId) => zoomable(cardFace(defId), "見せた手札", [defId])));
      row.append(hand);
      return row;
    }),
  );
}

function toggleButton(instanceId, pressed, onClick) {
  const button = el("button", "secondary", handCardName(instanceId, lastView));
  button.type = "button";
  button.dataset.instanceId = instanceId;
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", onClick);
  return button;
}

/**
 * 対戦準備で、何を選んでいるのか。
 *
 * まとめて出せないとき（マリガンの追加ドロー、たねが無く特性で出られるカードだけのとき）は、
 * エンジンの選択を 1 つずつ答える。準備は 1 人ずつ進むので、何も書かないと相手の番に移ったように見える。
 */
function promptText(view, mine, setup = null) {
  if (view?.phase !== "setup") return "";
  if (setup?.kind === "choose") {
    return "バトル場に出すポケモンを 1 枚と、ベンチに出すたねポケモンを選んで「準備を終える」を押してください。相手に見えるのは、両者が出し終えてからです。";
  }
  if (setup?.kind === "submitted") {
    const bench = setup.bench.map((id) => ownCardName(id, view)).join("、");
    const placed = `バトル場に ${ownCardName(setup.active, view)}${bench === "" ? "" : `、ベンチに ${bench}`}`;
    return `${placed} を出しました。相手の準備を待っています。`;
  }
  if (!mine) return "相手が対戦の準備で選んでいます。";
  const choice = view.choices.at(-1);
  switch (choice?.kind) {
    case "setup-place-active":
      // 選ばずに済むのは、候補が特性でバトル場に出られるカードだけのとき（出さなければ引き直し）。
      return choice.optional
        ? "バトル場に出すポケモンを選んでください。出さなければ手札を引き直します。"
        : "バトル場に出すたねポケモンを選んでください。";
    case "setup-place-bench":
      return "ベンチに出すたねポケモンを選んでください。出し終えたら「ベンチに出し終える」を押します。";
    case "setup-bonus-draw":
      return `相手が手札を引き直したので、${choice.prompt.max} 枚まで追加で引けます。引いたたねポケモンはベンチに出せます。`;
    default:
      return "";
  }
}

/**
 * 対戦準備の選択への答えの見出し。答えはカードか「はい」「いいえ」だけなので、
 * そのままではバトル場とベンチのどちらに出すのか、「いいえ」で何が起きるのかが読めない。
 */
const SETUP_ANSWERS = {
  "setup-place-active": { card: "をバトル場に出す", decline: "出さずに手札を引き直す" },
  "setup-place-bench": { card: "をベンチに出す", decline: "ベンチに出し終える" },
  "setup-bonus-draw": { decline: "追加で引かない" },
};

/**
 * 手の見出し。`Move` は判別可能ユニオンなので、型ごとに 1 行で書ける。
 * ここが知らない型が来ても、型の名前だけは出す。
 *
 * エネルギーやどうぐは、つける先の数だけ手が並ぶ。何をどこへ、まで書かないと見分けられない。
 *
 * 名前を引くのは その手を指す直前の盤面 からである。指したあとの盤面では、
 * 出したカードはもう手札に無い。指せる手を並べるときは、今の盤面がその直前にあたる。
 */
function describeMove(move, view = lastView) {
  const card = (instanceId) => cardName(instanceId, view);
  const target = (inPlayId) => pokemonLabel(inPlayId, view, false);
  switch (move.type) {
    case "PlayBasic":
      return `${card(move.cardInstanceId)} をベンチに出す`;
    case "Evolve":
      return `${target(move.target)} を ${card(move.cardInstanceId)} に進化させる`;
    case "AttachEnergy":
    case "AttachTool":
      return `${card(move.cardInstanceId)} を ${target(move.target)} につける`;
    case "PlayTrainer": {
      const defId = locateCard(move.cardInstanceId, view)?.defId;
      const verb = cards[defId]?.trainerKind === "stadium" ? "出す" : "使う";
      return `${card(move.cardInstanceId)} を${verb}`;
    }
    case "PlayStadiumPair":
      return `${card(move.right)} を出す`;
    case "UseAbility": {
      const top = pokemonAt(move.source, view)?.pokemon.stack.at(-1);
      return `${target(move.source)} の${abilityName(top?.defId, move.abilityIndex)}を使う`;
    }
    case "UseHandAbility": {
      const defId = locateCard(move.cardInstanceId, view)?.defId;
      return `手札の ${card(move.cardInstanceId)} の${abilityName(defId, move.abilityIndex)}を使う`;
    }
    case "UseStadiumEffect":
      return "スタジアムの効果を使う";
    case "Retreat":
      return `にげて、${target(move.to)} をバトル場に出す`;
    case "DiscardOwnPokemon":
      return `${target(move.target)} をトラッシュする`;
    case "Attack":
      return `ワザ「${attackName(move, view)}」を使う`;
    case "EndTurn":
      return "番を終わる";
    case "AnswerChoice":
      return describeAnswer(move.answer, view);
    default:
      return move.type;
  }
}

function abilityName(defId, index) {
  const name = cards[defId]?.abilities?.[index];
  return name === undefined ? "特性" : `特性「${name}」`;
}

/**
 * `attackIndex` は印刷されたワザの番号ではなく、どうぐなどで使えるようになったワザを
 * 後ろに足した表の番号である（エンジンの仕様 3.3 節）。印刷されたワザが前に並ぶので、
 * その数より小さければ名前が引ける。
 */
function attackName(move, view) {
  const side = move.player === view?.viewer ? view?.self : view?.opponent;
  const top = side?.active?.stack?.at(-1);
  return cards[top?.defId]?.attacks?.[move.attackIndex] ?? `${move.attackIndex + 1} 番目のワザ`;
}

/**
 * 選択の見出し。`ChoiceAnswer` も判別可能ユニオンで、運ぶ値は
 * カード、場の個体、位置、番号のいずれかである。
 * どの選択肢かはサーバが出した順で決まるので、ここでは値そのものを読める形にする。
 */
function describeAnswer(answer, view) {
  const choice = view?.choices?.at(-1);
  const setup = SETUP_ANSWERS[choice?.kind];
  if (setup?.[answer.kind] !== undefined) {
    return answer.kind === "card"
      ? `${handCardName(answer.card, view)} ${setup.card}`
      : setup[answer.kind];
  }
  switch (answer.kind) {
    case "accept":
      return "はい";
    case "decline":
      return "いいえ";
    case "card":
      return cardWithPlace(answer.card, view);
    case "cardDef":
      return nameOf(answer.defId);
    case "inPlay":
      return pokemonLabel(answer.target, view, true);
    case "position":
      return `${answer.index + 1} 番目`;
    case "effectIndex":
      return `${answer.index + 1} 番目の効果`;
    case "attackIndex": {
      const listed =
        choice?.prompt?.kind === "selectAttack"
          ? choice.prompt.candidates.find((each) => each.attackIndex === answer.index)
          : undefined;
      return listed === undefined ? `ワザ ${answer.index + 1}` : `ワザ「${listed.label}」`;
    }
    case "placement":
      return answer.placement === "before" ? "先に" : "あとに";
    case "bonusDrawCount":
      return `${answer.count} 枚引く`;
    default:
      return JSON.stringify(answer);
  }
}

/**
 * 座席から見た両側。リプレイの盤面も同じ形にしてある（`readerBoard`）。
 * 対戦中は相手の手札が `hand` を持たないので、自分の手札しか当たらない。
 */
function seatSides(view) {
  return [
    [true, view?.self],
    [false, view?.opponent],
  ].filter(([, side]) => side != null);
}

/** 描いている順のベンチ。空いた枠は描かないので、左からの番号もこれで数える。 */
const benched = (side) => side.bench.filter((pokemon) => pokemon !== null);

function pokemonAt(inPlayId, view) {
  for (const [own, side] of seatSides(view)) {
    if (side.active?.inPlayId === inPlayId) return { own, side, pokemon: side.active, bench: -1 };
    const index = benched(side).findIndex((pokemon) => pokemon.inPlayId === inPlayId);
    if (index >= 0) return { own, side, pokemon: benched(side)[index], bench: index };
  }
  return null;
}

const topName = (pokemon) =>
  pokemon.concealed === true ? "ウラのポケモン" : nameOf(pokemon.stack.at(-1).defId);

/**
 * 場のポケモンを、いる場所と合わせて書く。ベンチに同じ名前が並ぶときは左からの番号を足す。
 * `withSide` が偽なら、自分の側では「自分の」を省く。自分の番の手は自分の場にしか向かない。
 */
function pokemonLabel(inPlayId, view, withSide) {
  const found = pokemonAt(inPlayId, view);
  if (found === null) return inPlayId;
  const name = topName(found.pokemon);
  const twins = benched(found.side).filter((pokemon) => topName(pokemon) === name).length;
  const place =
    found.bench < 0 ? "バトル場" : twins > 1 ? `ベンチ左から ${found.bench + 1} 番目` : "ベンチ";
  const side = found.own ? (withSide ? "自分の" : "") : "相手の";
  return `${side}${place}の${name}`;
}

/**
 * インスタンス ID から、カードと、それがある場所を引く。`key` は同じ場所を同じ文字列にする。
 * 盤面に無ければ null（山札の中など）。
 */
function locateCard(instanceId, view) {
  for (const [own, side] of seatSides(view)) {
    const who = own ? "自分の" : "相手の";
    const piles = [
      ["hand", "手札", side.hand ?? []],
      ["discard", "トラッシュ", side.discard ?? []],
      ["lost", "ロストゾーン", side.lostZone ?? []],
    ];
    for (const [zone, label, pile] of piles) {
      const card = pile.find((each) => each.instanceId === instanceId);
      if (card !== undefined) {
        return { defId: card.defId, own, zone, key: `${own} ${zone}`, place: `${who}${label}` };
      }
    }
    for (const pokemon of [side.active, ...benched(side)]) {
      if (pokemon == null || pokemon.concealed === true) continue;
      for (const [part, pile] of [
        ["stack", pokemon.stack],
        ["attached", pokemon.attached],
      ]) {
        const card = pile.find((each) => each.instanceId === instanceId);
        if (card === undefined) continue;
        const place = pokemonLabel(pokemon.inPlayId, view, true);
        return { defId: card.defId, own, zone: part, key: `${pokemon.inPlayId} ${part}`, place };
      }
    }
  }
  return null;
}

/** 盤面に無ければ番号のまま出す。 */
function cardName(instanceId, view) {
  const found = locateCard(instanceId, view);
  return found === null ? instanceId : nameOf(found.defId);
}

/** 選択の候補のカード。手札から選ぶことが多いので、手札のときだけ場所を省く。 */
function cardWithPlace(instanceId, view) {
  const found = locateCard(instanceId, view);
  if (found === null) return instanceId;
  const name = nameOf(found.defId);
  return found.zone === "hand" && found.own ? name : `${name}（${found.place}）`;
}

/** 手札のインスタンス ID からカードの名前を引く。盤面に無ければ番号のまま出す。 */
function handCardName(instanceId, view) {
  const found = locateCard(instanceId, view);
  return found?.zone === "hand" ? nameOf(found.defId) : instanceId;
}

/** 手札か自分の場にある自分のカードの名前。出したあとのカードは手札から場へ移っている。 */
function ownCardName(instanceId, view) {
  const self = view?.self;
  const inPlay = [self?.active, ...(self?.bench ?? [])].flatMap((pokemon) => pokemon?.stack ?? []);
  const card = [...(self?.hand ?? []), ...inPlay].find((each) => each.instanceId === instanceId);
  return card === undefined ? instanceId : nameOf(card.defId);
}

/** 人に見せる文が無いイベントは、不具合を調べるときのために名前で残す。 */
function logEvents(events, results, list = "events") {
  for (const [index, event] of events.entries()) {
    const result = results[index];
    if (result?.repeated) continue;
    addEvent(result?.text ?? event.kind, list);
  }
}

function addEvent(text, list = "events") {
  const item = document.createElement("li");
  item.textContent = text;
  $(list).prepend(item);
}

/** 観戦の画面は代わりに `watchName` で座席の名前を使う。 */
function seatName(player) {
  return player === seat ? "あなた" : "相手";
}

/** 先攻のコイントスを見せた対戦。`sync` は繋ぎ直すたびに届くので、この画面で 2 度は出さない。 */
let firstPlayerShownFor = null;

/** 対戦が始まったあとに開いた画面では、先攻はもう済んだ話なので出さない。 */
function showFirstPlayer(key, firstPlayer, view) {
  if (firstPlayerShownFor === key || view.phase !== "setup") return;
  firstPlayerShownFor = key;
  const watching = view.viewer === "spectator";
  const text = watching
    ? `コイントスの結果、${watchName(firstPlayer)}が先攻です`
    : firstPlayer === seat
      ? "コイントスの結果、あなたが先攻です"
      : "コイントスの結果、相手が先攻です（あなたは後攻）";
  const results = [watching || firstPlayer === seat];
  showResult({ text, coins: { results, faces: ["先攻", "後攻"] } });
}

/**
 * 届いたイベントを、人に見せる結果へ直す。見せないイベントの位置は null にする。
 * 名前は適用後と適用前の盤面から引く。きぜつしたポケモンは適用後の盤面にもういない。
 */
function describeResults(events, views, who) {
  let previous = null;
  return events.map((event) => {
    const result = describeResult(event, views, who);
    const repeated = result?.key !== undefined && result.key === previous?.key;
    previous = result;
    return repeated ? { ...result, repeated: true } : result;
  });
}

function describeResult(event, views, who) {
  const pokemon = (inPlayId) => pokemonName(inPlayId, views, who) ?? "ポケモン";
  switch (event.kind) {
    case "coin-flipped": {
      const heads = event.results.filter(Boolean).length;
      const tails = event.results.length - heads;
      const summary =
        event.results.length === 1
          ? event.results[0]
            ? "オモテ"
            : "ウラ"
          : `オモテ ${heads} 回・ウラ ${tails} 回`;
      const cause =
        event.source !== null
          ? `（${nameOf(event.source.defId)}）`
          : event.window.kind === "pokemon-check"
            ? "（ポケモンチェック）"
            : "";
      return {
        text: `${who(event.player)}のコイン${cause}: ${summary}`,
        coins: { results: event.results, faces: ["オモテ", "ウラ"] },
      };
    }
    case "damage-dealt":
      return {
        text: `${pokemon(event.target)}に ${event.amount} ダメージ`,
        hit: { target: event.target, text: `-${event.amount}`, tone: "negative" },
      };
    case "damage-counters-placed": {
      // 載せた数は HP で頭打ちになる。浮かべるのは実際に増えたダメージのほうにする。
      const amount = event.afterDamage - event.beforeDamage;
      return {
        text: `${pokemon(event.target)}にダメカンを ${event.count} 個`,
        ...(amount > 0
          ? { hit: { target: event.target, text: `-${amount}`, tone: "negative" } }
          : {}),
      };
    }
    case "damage-healed":
      return {
        text: `${pokemon(event.target)}の HP を ${event.amount} 回復`,
        tone: "positive",
        hit: { target: event.target, text: `+${event.amount}`, tone: "positive" },
      };
    case "condition-applied":
      return { text: `${pokemon(event.target)}が${conditionName(event.condition)}になった` };
    case "condition-removed":
      return { text: `${pokemon(event.target)}の${conditionName(event.condition)}が治った` };
    case "pokemon-knocked-out":
      return { text: `${pokemon(event.target)}がきぜつした`, tone: "attention" };
    // まとめて取ると 1 枚ごとのイベントが続けて並ぶ。選んで取るときは 1 枚ずつ別の局面で届くので、
    // 枚数は `count`（今回取る総数）ではなく残りで伝え、続いたものは 1 つに畳む。
    case "prize-taken":
    case "prize-taken-hidden": {
      const side = sidesOf(views[0]).find(([player]) => player === event.player)?.[1];
      const left = side === undefined ? "" : `（残り ${side.prizeCount} 枚）`;
      return { text: `${who(event.player)}がサイドを取った${left}`, key: `prize-${event.player}` };
    }
    case "mulligan-taken":
      return { text: `${who(event.player)}の手札にたねポケモンが無く、引き直した` };
    case "turn-started":
      return { text: `${who(event.player)}の番`, tone: "turn" };
    default:
      return null;
  }
}

function conditionName(condition) {
  return CONDITIONS[condition.kind] ?? condition.kind;
}

/** 場のポケモンを「持ち主の名前」で呼ぶ。見つからなければ null。 */
function pokemonName(inPlayId, views, who) {
  for (const view of views) {
    for (const [player, side] of sidesOf(view)) {
      for (const pokemon of [side.active, ...side.bench]) {
        if (pokemon == null || pokemon.concealed === true || pokemon.inPlayId !== inPlayId)
          continue;
        return `${who(player)}の${nameOf(pokemon.stack[pokemon.stack.length - 1].defId)}`;
      }
    }
  }
  return null;
}

/** 座席の番号と、その座席の場の組。座席と観戦で盤面の形が違う。 */
function sidesOf(view) {
  if (!view) return [];
  if (view.viewer === "spectator") return view.players.map((side, player) => [player, side]);
  return [
    [view.viewer, view.self],
    [1 - view.viewer, view.opponent],
  ];
}

/** 盤面を描き直したあとに呼ぶ。数字を浮かべる先のポケモンは、描き直しで作り直されている。 */
function showResults(results, board) {
  for (const result of results) {
    if (result === null || result.repeated) continue;
    showResult(result);
    if (result.hit !== undefined) floatHit(board, result.hit);
  }
}

/**
 * 同時に出しておく結果の数。溢れたら古いものから消すが、コインは残す。1 つの手でもコイン、
 * ダメージ、特殊状態、きぜつ、番の交代と重なりうるので、古い順だとコインから先に消える。
 */
const RESULT_LIMIT = 5;
const RESULT_MS = 4_000;
/** コインは回り終えてから読むので、そのぶん長く残す。 */
const COIN_RESULT_MS = 6_000;

function showResult({ text, tone = "neutral", coins }) {
  const item = el("div", "result");
  item.dataset.tone = tone;
  if (coins !== undefined) item.append(coinRow(coins));
  item.append(el("p", "result-text", text));
  const box = $("results");
  box.append(item);
  while (box.childElementCount > RESULT_LIMIT) {
    const older = [...box.children].filter((child) => child !== item);
    (older.find((child) => child.querySelector(".coin") === null) ?? older[0]).remove();
  }
  setTimeout(() => item.remove(), coins === undefined ? RESULT_MS : COIN_RESULT_MS);
}

/** 読み上げには結果の文が同じことを言うので、コインの絵は読ませない。 */
function coinRow({ results, faces }) {
  const row = el("div", "coins");
  row.setAttribute("aria-hidden", "true");
  for (const [index, heads] of results.entries()) {
    const coin = el(
      "span",
      "coin",
      el(
        "span",
        "coin-inner",
        el("span", "coin-face heads", faces[0]),
        el("span", "coin-face tails", faces[1]),
      ),
    );
    coin.dataset.face = heads ? "heads" : "tails";
    coin.style.setProperty("--order", String(index));
    row.append(coin);
  }
  return row;
}

/** 盤面の外に置く。盤面は局面が届くたびに作り直すので、中に置くと次の局面で消える。 */
function floatHit(board, { target, text, tone }) {
  const pokemon = board.querySelector(`.pokemon[data-in-play-id="${CSS.escape(target)}"]`);
  if (pokemon === null) return;
  const rect = pokemon.getBoundingClientRect();
  const hit = el("span", "hit", text);
  hit.dataset.tone = tone;
  hit.setAttribute("aria-hidden", "true");
  hit.style.left = `${rect.left + rect.width / 2}px`;
  hit.style.top = `${rect.top + rect.height / 3}px`;
  document.body.append(hit);
  setTimeout(() => hit.remove(), RESULT_MS);
}

function watchUrl(spectatorToken) {
  return `${location.origin}/?watch=${encodeURIComponent(spectatorToken)}`;
}

let watchSeats = null;
/** 直近の観戦の盤面。カードの名前の表が遅れて届いたときに描き直す。 */
let lastWatchView = null;

/**
 * 観戦者が送るのは生きていることの `ping` だけである。
 * 切れたら座席と同じく繋ぎ直す。断られたら、観戦は断っても誰も負けないので、そこでやめる。
 */
function openWatch(token) {
  $("join").hidden = true;
  $("history").hidden = true;
  $("watch").hidden = false;
  loadCardsThen(redraw);

  let synced = false;
  let ended = false;
  const retry = reconnector(connect);
  connect();

  function connect() {
    const watching = new WebSocket(socketUrl(`spectatorToken=${encodeURIComponent(token)}`));
    /** 閉じる直前にサーバが言った理由。入れなかったときに、そのまま見せる。 */
    let refusal = null;
    let lost = false;
    let joined = false;
    keepAlive(watching, onLost);
    watching.addEventListener("message", (event) => {
      if (lost) return;
      const message = JSON.parse(event.data);
      switch (message.t) {
        case "spectator-sync":
          synced = true;
          if (!joined) retry.connected();
          joined = true;
          $("watch-status").textContent = "";
          watchSeats = message.seats;
          renderWatch(message.view);
          showFirstPlayer(token, message.firstPlayer, message.view);
          renderWatchClock(message.clock);
          return;
        case "spectator-delta": {
          const results = describeResults(message.events, [message.view, lastWatchView], watchName);
          logEvents(message.events, results, "watch-events");
          renderWatch(message.view);
          showResults(results, $("watch"));
          renderWatchClock(message.clock);
          return;
        }
        case "spectator-ended":
          ended = true;
          renderWatch(message.view);
          $("watch-clock").textContent = describeWatchEnd(message.matchResult);
          showResult({ text: describeWatchEnd(message.matchResult) });
          return;
        case "error":
          refusal = message.message;
          if (synced) {
            addEvent(message.message, "watch-events");
            showResult({ text: message.message, tone: "attention" });
          }
          return;
        default:
          return;
      }
    });
    watching.addEventListener("close", onLost);

    function onLost() {
      if (lost) return;
      lost = true;
      if (ended) {
        retry.stop();
        return;
      }
      if (!synced || refusal !== null) {
        retry.stop();
        $("watch-status").textContent =
          refusal === null
            ? "サーバへ繋がりませんでした。読み込み直すと、もう一度繋ぎます。"
            : `観戦できませんでした（${refusal}）`;
        return;
      }
      const attempt = retry.schedule();
      $("watch-status").textContent = `接続が切れました。繋ぎ直しています（${attempt} 回目）`;
    }
  }
}

function renderWatch(view) {
  lastWatchView = view;
  for (const seat of [0, 1]) {
    const info = watchSeats?.[seat];
    $(`watch-name-${seat}`).textContent =
      info === undefined ? `座席 ${seat}` : `${info.displayName}（${info.rating}）`;
    renderSide($(`watch-side-${seat}`), view.players[seat], seat === 1);
  }
  renderStadium($("watch-stadium"), view.stadium);
}

function watchName(seat) {
  return watchSeats?.[seat]?.displayName ?? `座席 ${seat}`;
}

function renderWatchClock(clock) {
  const turn = clock.toMove === null ? "" : `${watchName(clock.toMove)} が考えています`;
  const remaining = moveRemainingText(clock);
  const banks = [0, 1]
    .map((seat) => `${watchName(seat)} ${Math.round(clock.bankMs[seat] / 1000)} 秒`)
    .join("・");
  $("watch-clock").textContent = `${turn}${remaining} ／ 持ち時間 ${banks}`;
}

function describeWatchEnd(result) {
  if (result.winner === null) return "引き分けで終わりました";
  const how = { normal: "", concede: "（投了）", timeout: "（時間切れ）" }[result.kind] ?? "";
  return `${watchName(result.winner)} の勝ちで終わりました${how}`;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }
  // 押してから確かめるまでのあいだに切れることがある。黙って捨てると、送れたと思われる。
  addEvent("接続が切れているので送れませんでした。繋がってから、もう一度押してください。");
}

function setStatus(text) {
  $("join-status").textContent = text;
}

/**
 * プレイヤーのシークレット。サーバは控えを持たないので、失うとその戦績には戻れない。
 * この画面は確認用なので、localStorage に置くだけにしておく。
 */
function storedSecret() {
  return localStorage.getItem("poke-account-secret");
}

/**
 * プレイヤーを 1 人だけ用意する。
 *
 * 実行中の呼び出しを待ち合わせる。 画面を開いたときの読み込みと、
 * それを待たずに押された「対戦をさがす」が重なると、プレイヤーが 2 人できる。
 * 画面に出ているレーティングと、実際に指すプレイヤーが食い違い、片方が迷子になる。
 */
function ensureAccount() {
  // 失敗したものを覚えると二度と作り直せないので、そのときだけ忘れる。
  loadingAccount ??= loadAccount()
    .then((account) => {
      showAccount(account);
      // 読めたときは必ず欄へ入れる。画面を開いたときの 1 回だけにしない。
      // 開いたときに失敗すると、欄は既定の「ななし」のまま残る。次に「対戦をさがす」で
      // 読み直して通っても入れ直さないと、その「ななし」が表示名として送られる。
      if (!nameTouched) $("name").value = account.displayName;
      return account;
    })
    .catch((error) => {
      loadingAccount = null;
      throw error;
    });
  return loadingAccount;
}

/** シークレットが無ければプレイヤーを作る。あれば戦績を読み直す。 */
async function loadAccount() {
  const secret = storedSecret();
  if (secret !== null) {
    const response = await fetch("/api/account/me", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    if (response.ok) return response.json();
    /**
     * **消すのは、サーバが「そのアカウントはいない」と言ったときだけである。**
     * サーバはシークレットの控えを持たないので、ここで消すとレーティングも戦績もリプレイも戻らない。
     * 404 という番号だけでは足りない。静的ファイルの取りこぼしも、前の版が動いている
     * サーバも、間に挟まった中継も 404 を返す。合図が付いている応答だけを本物とする。
     */
    const failure = await response.json().catch(() => null);
    if (failure?.code !== "account-not-found") {
      throw new Error(
        `アカウントを読めなかった（${response.status}）。シークレットはそのまま残してある。`,
      );
    }
    localStorage.removeItem("poke-account-secret");
  }
  const created = await postJson("/api/account", {
    displayName: $("name").value.trim() || "ななし",
  });
  // シークレットとして置けるのは文字列だけである。`undefined` を置くと次に開くまで直らない。
  if (typeof created?.secret !== "string") throw new Error("プレイヤーを作れなかった");
  localStorage.setItem("poke-account-secret", created.secret);
  return created.account;
}

/** レーティングと戦績の 1 行。名前の欄には触れない。 入力の途中かもしれない。 */
function showAccount(account) {
  const record =
    account.games === 0
      ? "まだ対戦していません"
      : `${account.games} 戦 ${account.wins} 勝 ${account.losses} 敗 ${account.draws} 分`;
  $("account").textContent = `レーティング ${account.rating}（${record}）`;
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} が ${response.status} を返した`);
  return response.json();
}

/**
 * 応答の可否を見る。 見ないと、誤りの本文をそのまま中身として読むことになり、
 * `undefined` を触った先で分かりにくい誤りになる。サーバの言い分をそのまま持ち上げる。
 *
 * ただし **`ok: false` は投げない。** 「デッキのここが規則に通らない」のような、
 * 呼び手が読んで人に見せるためのエラー応答である。投げると理由が落ちて、
 * 「400 が返った」しか出せなくなる。通信が失敗したこととは別の話である。
 */
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await response.json().catch(() => null);
  if (response.ok || answer?.ok === false) return answer;
  throw new Error(answer?.error ?? `${path} が ${response.status} を返した`);
}

/** リプレイ中の対戦。開いていなければ null。 */
let replaying = null;
/** 直近に描いたリプレイの局面。名前の表や画像の設定が遅れて届いたときに描き直す。 */
let lastReplayFrame = null;

$("history-button").addEventListener("click", () => {
  showHistory().catch((error) => setStatus(`一覧を出せませんでした: ${error.message}`));
});

$("replay-close").addEventListener("click", () => {
  replaying = null;
  lastReplayFrame = null;
  $("replay").hidden = true;
});

for (const [id, step] of [
  ["replay-first", () => 0],
  ["replay-prev", (ply) => ply - 1],
  ["replay-next", (ply) => ply + 1],
  ["replay-last", () => replaying.moveCount],
]) {
  $(id).addEventListener("click", () => {
    if (replaying === null) return;
    // 数えるのは頼んだ手数からである。描けた手数から数えると、続けて押したぶんが
    // すべて同じ 1 手への問い合わせになり、6 回押しても 1 手しか進まない。
    goToPly(step(replaying.wanted)).catch((error) => {
      $("replay-status").textContent = `辿れませんでした: ${error.message}`;
    });
  });
}

async function showHistory() {
  // プレイヤーができるのを待つ。 初めて来た人はシークレットをまだ持たないので、
  // 待たずに送ると `secret: null` になり、「アカウントが見つからない」と断られる。
  await ensureAccount();
  if (Object.keys(cards).length === 0) await loadCards();
  const { matches } = await postJson("/api/matches", { secret: storedSecret() });
  const list = $("history-list");
  list.innerHTML = "";
  if (matches.length === 0) {
    list.textContent = "まだ読み返せる対戦がありません。";
    return;
  }
  for (const summary of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = describeSummary(summary);
    button.addEventListener("click", () => {
      openReplay(summary).catch((error) => setStatus(`開けませんでした: ${error.message}`));
    });
    list.append(button);
  }
}

function describeSummary(summary) {
  const outcome = { win: "勝ち", loss: "負け", draw: "引き分け" }[summary.outcome];
  const how = { normal: "", concede: "（投了）", timeout: "（時間切れ）" }[
    summary.matchResult.kind
  ];
  const when = new Date(summary.endedAt).toLocaleString("ja-JP");
  return `${when} ${summary.opponentName} と ${outcome}${how} ${summary.moveCount} 手`;
}

async function openReplay(summary) {
  const opened = {
    matchId: summary.matchId,
    seat: summary.seat,
    /** 描けている手数。 */
    ply: 0,
    /** 頼んだ手数。まだ返ってきていないぶんを含む。 */
    wanted: 0,
    moveCount: summary.moveCount,
    // 出した順に番号を振る。返ってくる順は、これと同じとは限らない。
    asked: 0,
  };
  replaying = opened;
  $("replay").hidden = false;
  try {
    await goToPly(0);
  } catch (error) {
    // 開けないものを空の欄で見せない。エラーは一覧のところに出す。
    // いま開いているものが自分のときだけ閉じる。 先に別の対戦を開いていれば、
    // 遅れて届いたこちらの失敗で、映っているほうを閉じることになる。
    if (replaying === opened) {
      $("replay").hidden = true;
      replaying = null;
      lastReplayFrame = null;
    }
    throw error;
  }
}

/**
 * その手数の局面を取りに行って描く。局面を持たないので、毎回サーバが作り直す。
 *
 * **古い応答では描かない。** 「1 手 ▶」を続けて押したり別の対戦へ移ったりすると、
 * 出した順と返る順が入れ替わる。あとから来た古い盤面で上書きすると、
 * 手数の表示と盤面がずれたまま残る。
 */
async function goToPly(ply) {
  if (replaying === null) return;
  const opened = replaying;
  const mine = ++opened.asked;
  const wanted = Math.max(0, Math.min(ply, opened.moveCount));
  opened.wanted = wanted;
  let frame;
  try {
    ({ frame } = await postJson("/api/replay", {
      secret: storedSecret(),
      matchId: opened.matchId,
      ply: wanted,
    }));
  } catch (error) {
    // 行き先を戻す。 戻さないと、1 度失敗しただけで次に押したぶんが 1 手飛ぶ。
    // あとから出したぶんが走っていれば、その行き先のほうが新しいので触らない。
    if (replaying === opened && mine === opened.asked) opened.wanted = opened.ply;
    throw error;
  }
  // 別の対戦へ移ったか、あとから出した問い合わせが先に返っていれば、これは捨てる。
  if (replaying !== opened || mine !== opened.asked) return;
  replaying.ply = frame.ply;
  /**
   * **辿れる上限を、再現できる地点まで下げる。** 下げないと「さいごまで」がその先を
   * 頼み続け、毎回同じ手数が返ってきて進まないように見える。
   */
  if (frame.divergedAt !== null) {
    opened.moveCount = frame.divergedAt;
    opened.wanted = frame.ply;
  }

  lastReplayFrame = { views: frame.views, seat: replaying.seat };
  renderReplayBoard(lastReplayFrame);

  const before = readerBoard(frame.beforeViews, replaying.seat);
  const move = frame.playedMove === null ? "対戦の開始時" : describeMove(frame.playedMove, before);
  // エンジンの版が違っても止めない。止めるのはカードの定義が変わったときだけである（§6.3）。
  const warning = frame.engineCommitDiffers
    ? "　※ この対戦を指したときとエンジンの版が違います"
    : "";
  // 記録された手が、いまのエンジンでは合法でなくなった地点。ここから先は辿れない。
  const diverged =
    frame.divergedAt === null
      ? ""
      : `　※ ${frame.divergedAt} 手目から先は、いまのエンジンでは再現できません`;
  $("replay-status").textContent =
    `${frame.ply} / ${frame.moveCount} 手　直前の手: ${move}${warning}${diverged}`;
}

/**
 * 座席ごとの射影 2 つを、読み手から見た 1 枚の盤面にする。
 *
 * 相手の側も相手自身の射影の `self` から取る。終わった対戦なので、相手の手札も
 * そのまま見えてよい（6.6 節）。
 */
function readerBoard(views, seat) {
  if (!views) return null;
  return {
    viewer: seat,
    self: views[seat].self,
    opponent: views[seat === 0 ? 1 : 0].self,
    choices: views[seat].choices,
  };
}

function renderReplayBoard({ views, seat }) {
  const board = readerBoard(views, seat);
  renderSide($("replay-opponent"), board.opponent, true);
  renderStadium($("replay-stadium"), views[seat].stadium);
  renderSide($("replay-self"), board.self, false);
}
