/**
 * 参照クライアント（`docs/spec/battle-server.md` 0 節「スコープ外」）。
 *
 * 見た目は仕様の対象外なので、この画面はプロトコルが運ぶ値をそのまま映すだけにする。
 * **盤面の判断を一切持たない。** サーバが送ってきた合法手を並べ、押された 1 つを送り返す。
 * 権威はサーバの局面にあり、こちらは描くだけである（1 節の S-1）。
 */

const $ = (id) => document.getElementById(id);

/** defId から名前を引く表。対戦ごとに変わらないので一度だけ取る。 */
let cards = {};
let socket = null;
let seat = null;
let stateVersion = 0;
/** 直近の盤面。手の見出しでインスタンス ID からカードの名前を引くのに使う。 */
let lastView = null;
/** 実行中のプレイヤーの読み込み。`ensureAccount` がこれを待ち合わせる。 */
let loadingAccount = null;

/**
 * 指している座席を置く鍵。
 *
 * **持たずに閉じると、その対戦には二度と入れない。** 繋ぎ直しに要るのは座席トークンだけ
 * （3.3 節）だが、この画面はそれを対戦のあいだメモリに持つだけだった。切断中も時計は
 * 流れるので（3.4 節）、戻れないまま時間切れで負ける。
 */
const SEAT_KEY = "poke-seat";

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
if (watchToken !== null) {
  openWatch(watchToken);
} else {
  ensureAccount().catch((error) => setStatus(`アカウントを読めませんでした: ${error.message}`));
  resumeSeat();
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
  loadCardsThen(() => {
    if (lastView !== null) renderView(lastView);
  });
}

/** 名前の表を待たずに描き始める画面向け。届いたら `redraw` で描き直す。 */
function loadCardsThen(redraw) {
  getJson("/api/cards")
    .then((loaded) => {
      cards = loaded;
      redraw();
    })
    .catch(() => {});
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

$("concede-button").addEventListener("click", () => {
  if (socket !== null && confirm("投了しますか。")) send({ t: "concede" });
});

async function join() {
  setStatus("デッキを送っています");
  cards = await getJson("/api/cards");
  // ここで名前の欄を書き戻さない。 書き戻すと、入力した名前が消えてから読まれる。
  await ensureAccount();
  const deck = await deckToSubmit();
  if (deck === null) {
    setStatus("デッキを直してから、もう一度おしてください。");
    return;
  }

  const room = $("room").value.trim();
  const request = {
    secret: storedSecret(),
    deck: { cards: deck.cards },
  };
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
  if (outcome.seat !== undefined) {
    openMatch(outcome.seat);
    return;
  }
  setStatus("相手を待っています");
  await waitForOpponent(outcome.ticket);
}

/** 書かれていれば解決した結果、空ならサンプルデッキ。通らなければ null。 */
async function deckToSubmit() {
  if ($("decklist").value.trim() === "") {
    showDeckStatus(["サンプルデッキで対戦します。"], "ok");
    return getJson("/api/sample-deck");
  }
  return checkDeck();
}

/**
 * 書いたデッキをサーバに解決させる。名前から defId は一意に決まらないので、
 * 選べなかった行には候補をそのまま並べる。こちらでは推測しない。
 */
async function checkDeck() {
  if (Object.keys(cards).length === 0) cards = await getJson("/api/cards");
  const text = $("decklist").value;
  if (text.trim() === "") {
    showDeckStatus(["デッキが書かれていません。"], "ng");
    return null;
  }
  const outcome = await postJson("/api/deck/resolve", { text });
  if (outcome.ok) return outcome.deck;
  showDeckStatus(outcome.errors ?? ["デッキが通りませんでした。"], "ng", outcome.failures ?? []);
  return null;
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
      button.textContent = describeChoice(failure.name, choice);
      button.addEventListener("click", () => pickChoice(failure.line, failure.name, choice.defId));
      list.append(button);
    }
    box.append(list);
  }
}

const STAGES = { basic: "たね", stage1: "1 進化", stage2: "2 進化" };

function describeChoice(name, choice) {
  const parts = [];
  if (choice.hp !== undefined) parts.push(`HP ${choice.hp}`);
  if (choice.stage !== undefined) parts.push(STAGES[choice.stage] ?? choice.stage);
  if (choice.set !== undefined) parts.push(`${choice.set} ${choice.number ?? ""}`.trim());
  return parts.length === 0 ? `${name}（${choice.defId}）` : `${name}（${parts.join(" ")}）`;
}

/** 選んだ候補を、その行のうしろへ書き足す。 */
function pickChoice(line, name, defId) {
  const lines = $("decklist").value.split("\n");
  const index = line - 1;
  if (lines[index] === undefined) return;
  lines[index] = `${lines[index].trim()} ${defId}`;
  $("decklist").value = lines.join("\n");
  checkDeck()
    .then((deck) => {
      if (deck !== null)
        showDeckStatus([`デッキは ${deck.cards.length} 枚で、規則を通ります。`], "ok");
    })
    .catch((error) => showDeckStatus([`確かめられませんでした: ${error.message}`], "ng"));
}

/**
 * 相手が見つかるまで取りに行く。
 *
 * チケットが降りていたら待つのをやめる。 同じプレイヤーが別のタブから入ると古いチケットは降りる。
 * それを「まだ待っている」と読むと、このタブは永久に問い合わせ続けることになる。
 */
async function waitForOpponent(ticket) {
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
      openMatch(claimed.seat);
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
  seat = seated.seat;
  rememberSeat(seated);
  setStatus("");
  $("join").hidden = true;
  $("table").hidden = false;

  socket = new WebSocket(socketUrl(`seatToken=${encodeURIComponent(seated.seatToken)}`));
  /**
   * 一度でも `sync` が届いたかどうか。閉じた理由を分けるのに使う。
   *
   * 届く前に閉じたなら、サーバはこの座席を知らない（対戦はもう終わっている）。
   * 覚えている座席を持ったままだと、開き直すたびに同じ座席へ繋ぎに行って同じ形で閉じ、
   * マッチングの画面に戻れなくなる。
   */
  let synced = false;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.t === "sync") synced = true;
    receive(message);
  });
  socket.addEventListener("close", () => {
    if (storedSeat() === null) return;
    if (synced) {
      addEvent("接続が切れました。読み込み直すと戻れます");
      return;
    }
    forgetSeat();
    backToJoin("指していた対戦は、もう終わっています。");
  });
}

/** マッチングの画面へ戻す。座席を失ったときだけ通る。 */
function backToJoin(text) {
  socket = null;
  seat = null;
  $("table").hidden = true;
  $("join").hidden = false;
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
    case "delta":
      if (message.t === "sync") $("watch-link").value = watchUrl(message.spectatorToken);
      stateVersion = message.stateVersion;
      if (message.events !== undefined) for (const event of message.events) addEvent(event.kind);
      renderView(message.view);
      renderClock(message.clock);
      renderMoves(message.legalMoves);
      return;
    case "ended":
      // 終わった座席へは繋ぎ直せない。覚えたままだと、次に開いたときに繋ぎに行って断られる。
      forgetSeat();
      // 観戦トークンも終わった対戦では通らない。残すと、渡された人が開いても入れない。
      $("watch-link").value = "";
      renderView(message.view);
      renderMoves(null);
      addEvent(describeEnd(message));
      $("clock").textContent = "対戦は終わりました";
      // 決着でレーティングが動く。開いた時点の値のまま置かない。
      refreshAccount().catch(() => {});
      return;
    case "reject":
      // 古い画面から押したときは、サーバが正しい局面を送り直してくる。
      addEvent(`手が通りませんでした（${message.reason}）`);
      return;
    case "error":
      addEvent(message.message);
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
  return `${mine}（${message.outcome?.reason ?? ""}）`;
}

function renderView(view) {
  lastView = view;
  $("opponent").innerHTML = sideHtml(view.opponent, false);
  $("self").innerHTML = sideHtml(view.self, true);
}

function sideHtml(side, own) {
  const rows = [
    row("サイド", side.prizeCount),
    row("山札", side.deckCount),
    row("手札", own ? side.hand.length : side.handCount),
    row("バトル場", pokemonText(side.active)),
    row(
      "ベンチ",
      side.bench
        .map(pokemonText)
        .filter((text) => text !== "なし")
        .join(" / ") || "なし",
    ),
    row("トラッシュ", side.discard.length),
  ];
  const hand = own
    ? `<div class="hand">${side.hand.map((card) => `<span>${escape(nameOf(card.defId))}</span>`).join("")}</div>`
    : "";
  return rows.join("") + hand;
}

function pokemonText(pokemon) {
  if (pokemon === null) return "なし";
  if (pokemon.concealed === true) return "ウラ";
  const top = pokemon.stack[pokemon.stack.length - 1];
  const damage = pokemon.damage > 0 ? `（${pokemon.damage} ダメージ）` : "";
  return `${escape(nameOf(top.defId))}${damage}`;
}

function row(label, value) {
  return `<div class="row"><span>${label}</span><span>${escape(String(value))}</span></div>`;
}

function renderClock(clock) {
  const mine = Math.round(clock.bankMs[seat] / 1000);
  const theirs = Math.round(clock.bankMs[1 - seat] / 1000);
  const turn = clock.toMove === seat ? "あなたの番です" : "相手が考えています";
  const remaining = moveRemainingText(clock);
  $("clock").textContent = `${turn}${remaining} ／ 持ち時間 自分 ${mine} 秒・相手 ${theirs} 秒`;
}

function renderMoves(moves) {
  const container = $("moves");
  container.innerHTML = "";
  if (moves === null) {
    container.innerHTML = '<p class="waiting">相手の番です</p>';
    return;
  }
  for (const move of moves) {
    const button = document.createElement("button");
    button.textContent = describeMove(move);
    button.addEventListener("click", () => send({ t: "move", stateVersion, move }));
    container.append(button);
  }
}

/**
 * 手の見出し。`Move` は判別可能ユニオンなので、型ごとに 1 行で書ける。
 * ここが知らない型が来ても、型の名前だけは出す。
 *
 * 名前を引くのは その手を指す直前の盤面 からである。指したあとの盤面では、
 * 出したカードはもう手札に無い。指せる手を並べるときは、今の盤面がその直前にあたる。
 */
function describeMove(move, view = lastView) {
  switch (move.type) {
    case "PlayBasic":
      return `${handCardName(move.cardInstanceId, view)} をだす`;
    case "Evolve":
      return "進化させる";
    case "AttachEnergy":
      return "エネルギーをつける";
    case "PlayTrainer":
    case "PlayStadiumPair":
      return "トレーナーズを使う";
    case "AttachTool":
      return "どうぐをつける";
    case "UseAbility":
    case "UseHandAbility":
      return "特性を使う";
    case "UseStadiumEffect":
      return "スタジアムの効果を使う";
    case "Retreat":
      return "にげる";
    case "DiscardOwnPokemon":
      return "自分のポケモンをトラッシュする";
    case "Attack":
      return `ワザ ${move.attackIndex + 1} を使う`;
    case "EndTurn":
      return "番を終わる";
    case "AnswerChoice":
      return describeAnswer(move.answer, view);
    default:
      return move.type;
  }
}

/**
 * 選択の見出し。`ChoiceAnswer` も判別可能ユニオンで、運ぶ値は
 * カード、場の個体、位置、番号のいずれかである。
 * どの選択肢かはサーバが出した順で決まるので、ここでは値そのものを読める形にする。
 */
function describeAnswer(answer, view) {
  switch (answer.kind) {
    case "accept":
      return "はい";
    case "decline":
      return "いいえ";
    case "card":
      return handCardName(answer.card, view);
    case "cardDef":
      return nameOf(answer.defId);
    case "inPlay":
      return inPlayName(answer.target, view);
    case "position":
      return `${answer.index + 1} 番目`;
    case "effectIndex":
      return `${answer.index + 1} 番目の効果`;
    case "attackIndex":
      return `ワザ ${answer.index + 1}`;
    case "placement":
      return answer.placement === "before" ? "先に" : "あとに";
    default:
      return JSON.stringify(answer);
  }
}

/** 場のインスタンス ID から、いちばん上のカードの名前を引く。 */
function inPlayName(inPlayId, view) {
  if (!view) return inPlayId;
  for (const side of [view.self, view.opponent]) {
    for (const pokemon of [side.active, ...side.bench]) {
      if (pokemon === null || pokemon.concealed === true) continue;
      if (pokemon.inPlayId !== inPlayId) continue;
      const own = side === view.self ? "自分の" : "相手の";
      return own + nameOf(pokemon.stack[pokemon.stack.length - 1].defId);
    }
  }
  return inPlayId;
}

/**
 * 手札のインスタンス ID からカードの名前を引く。盤面に無ければ番号のまま出す。
 *
 * 両側を見るのはリプレイのためである。対戦中は相手の手札が `hand` を持たないので、
 * 自分の手札しか当たらない。
 */
function handCardName(instanceId, view) {
  for (const side of [view?.self, view?.opponent]) {
    const card = side?.hand?.find((held) => held.instanceId === instanceId);
    if (card !== undefined) return nameOf(card.defId);
  }
  return instanceId;
}

function addEvent(text, list = "events") {
  const item = document.createElement("li");
  item.textContent = text;
  $(list).prepend(item);
}

function watchUrl(spectatorToken) {
  return `${location.origin}/?watch=${encodeURIComponent(spectatorToken)}`;
}

let watchSeats = null;
/** 直近の観戦の盤面。カードの名前の表が遅れて届いたときに描き直す。 */
let lastWatchView = null;

/**
 * こちらから送るものは無い。生存確認はサーバの ping にブラウザが自分で答える。
 */
function openWatch(token) {
  $("join").hidden = true;
  $("history").hidden = true;
  $("watch").hidden = false;
  loadCardsThen(() => {
    if (lastWatchView !== null) renderWatch(lastWatchView);
  });

  const watching = new WebSocket(socketUrl(`spectatorToken=${encodeURIComponent(token)}`));
  let synced = false;
  let ended = false;
  /** 閉じる直前にサーバが言った理由。入れなかったときに、そのまま見せる。 */
  let refusal = null;
  watching.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    switch (message.t) {
      case "spectator-sync":
        synced = true;
        watchSeats = message.seats;
        renderWatch(message.view);
        renderWatchClock(message.clock);
        return;
      case "spectator-delta":
        for (const played of message.events) addEvent(played.kind, "watch-events");
        renderWatch(message.view);
        renderWatchClock(message.clock);
        return;
      case "spectator-ended":
        ended = true;
        renderWatch(message.view);
        $("watch-clock").textContent = describeWatchEnd(message.matchResult);
        return;
      case "error":
        refusal = message.message;
        if (synced) addEvent(message.message, "watch-events");
        return;
      default:
        return;
    }
  });
  watching.addEventListener("close", () => {
    if (ended) return;
    $("watch-status").textContent = synced
      ? "接続が切れました。読み込み直すと戻れます"
      : `観戦できませんでした（${refusal ?? "対戦が見つからない"}）`;
  });
}

function renderWatch(view) {
  lastWatchView = view;
  for (const seat of [0, 1]) {
    const info = watchSeats?.[seat];
    $(`watch-name-${seat}`).textContent =
      info === undefined ? `座席 ${seat}` : `${info.displayName}（${info.rating}）`;
    $(`watch-side-${seat}`).innerHTML = sideHtml(view.players[seat], false);
  }
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
  if (socket !== null) socket.send(JSON.stringify(message));
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

$("history-button").addEventListener("click", () => {
  showHistory().catch((error) => setStatus(`一覧を出せませんでした: ${error.message}`));
});

$("replay-close").addEventListener("click", () => {
  replaying = null;
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
  if (Object.keys(cards).length === 0) cards = await getJson("/api/cards");
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

  const board = readerBoard(frame.views, replaying.seat);
  $("replay-self").innerHTML = sideHtml(board.self, true);
  $("replay-opponent").innerHTML = sideHtml(board.opponent, true);

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
  return { self: views[seat].self, opponent: views[seat === 0 ? 1 : 0].self };
}

function escape(text) {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}
