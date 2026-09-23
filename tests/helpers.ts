/**
 * テストの共通の足場。ランダムな合法手で 1 対戦を最後まで指す。
 *
 * エンジンへ触れるのは `src/engine.ts` 経由だけにする。テストの都合で
 * `engine/` の内部を直に読むと、エンジンの取り込み方を変えたときに直す場所が増える。
 */

import type {
  CardDef,
  CardDefId,
  DeckList,
  DomainEvent,
  GameState,
  Move,
  Player,
  Viewer,
} from "../src/engine.js";
import {
  createRng,
  legalMoves,
  loadGeneratedCards,
  nextInt,
  registerPoolCards,
} from "../src/engine.js";
import { sampleDeck } from "../src/sample-deck.js";
import { commitSeed } from "../src/fingerprint.js";
import { createMatch, submitMove, toMove, type Match } from "../src/match.js";

let registered = false;

/** カードの登録は 1 プロセスに 1 回で足りる。 */
export function ensureCards(): void {
  if (registered) return;
  registerPoolCards();
  registered = true;
}

/** 検査を通る 60 枚を 2 つ。登録済みのカードから実行時に組む（`src/sample-deck.ts`）。 */
export function legalDecks(): [DeckList, DeckList] {
  ensureCards();
  return [sampleDeck(), sampleDeck()];
}

/** 登録済みのカードから 1 つ拾う。テストが `defId` を書き写さないためのヘルパー。 */
function findDefId(matches: (def: CardDef) => boolean): CardDefId {
  ensureCards();
  const found = [...loadGeneratedCards()]
    .sort((a, b) => (a.defId < b.defId ? -1 : 1))
    .find(matches);
  if (found === undefined) throw new Error("条件に合うカードが登録されていない");
  return found.defId;
}

export function basicEnergyDefId(): CardDefId {
  return findDefId((def) => def.kind === "energy" && def.basic);
}

export function newMatch(seedNonce: string, nowMs = 0): Match {
  return createMatch({
    matchId: `match-${seedNonce}`,
    decks: legalDecks(),
    seats: [
      { playerId: "player-a", displayName: "あ", rating: 1500 },
      { playerId: "player-b", displayName: "い", rating: 1500 },
    ],
    seatTokens: [`token-a-${seedNonce}`, `token-b-${seedNonce}`],
    spectatorToken: `token-watch-${seedNonce}`,
    nowMs,
    startedAt: new Date(nowMs).toISOString(),
    seedCommitment: commitSeed(seedNonce),
  });
}

export interface PlayOptions {
  /** 1 手ごとに呼ぶ。漏洩の検査はここに差し込む。 */
  inspect?: (match: Match, seat: Player) => void;
  /** 手の数の上限。越えたら打ち切る（決着しない構成でテストが止まらないように）。 */
  maxMoves?: number;
  /** 手番側が 1 手に掛ける時間。持ち時間のテストで使う。 */
  thinkMs?: number;
  /** 1 手を適用するたびに、適用前の局面と出たイベントを添えて呼ぶ。イベントの漏洩の検査に使う。 */
  applied?: (before: GameState, match: Match, events: DomainEvent[]) => void;
}

export interface PlayedMatch {
  match: Match;
  moves: number;
  finished: boolean;
}

/** ランダムな合法手で対戦を進める。`submitMove` を通すので、サーバ側の検査も一緒に踏む。 */
export function playToEnd(match: Match, rngSeed: number, options: PlayOptions = {}): PlayedMatch {
  const maxMoves = options.maxMoves ?? 4000;
  const thinkMs = options.thinkMs ?? 0;
  let rng = createRng(rngSeed);
  let nowMs = match.turnStartedAtMs;
  let moves = 0;

  for (;;) {
    const mover = toMove(match);
    if (mover === null) return { match, moves, finished: true };
    if (moves >= maxMoves) return { match, moves, finished: false };

    for (const seat of [0, 1] as Player[]) options.inspect?.(match, seat);

    const legal = legalMoves(match.state);
    const [index, next] = nextInt(rng, legal.length);
    rng = next;
    nowMs += thinkMs;
    const before = match.state;
    const outcome = submitMove(match, mover, match.version, legal[index] as Move, nowMs);
    if (!outcome.ok) throw new Error(`合法手が拒否された: ${outcome.reason}`);
    options.applied?.(before, match, outcome.events);
    moves += 1;
  }
}

/**
 * ある宛先から見て中身が隠れているカードのインスタンス ID （4.2 節の「隠れているカード」）。
 * 観戦者はどちらの手札の持ち主でもないので、両者の手札が入る。
 */
export function hiddenInstanceIds(state: GameState, viewer: Viewer): Set<string> {
  const hidden = new Set<string>();
  for (const player of [0, 1] as Player[]) {
    const side = state.players[player];
    // 山札とサイドは両者から隠れている。オモテのサイドもインスタンス ID は出さない
    // （`playerView` の `faceUpPrizes` は位置と `defId` だけを運ぶ）。
    for (const card of side.deck) hidden.add(card.instanceId);
    for (const card of side.prizes) hidden.add(card.instanceId);
    if (player !== viewer) for (const card of side.hand) hidden.add(card.instanceId);
  }
  return hidden;
}

/**
 * ある宛先から見て正体の分からないカード。`hiddenInstanceIds` と違い、オモテのサイドを除く。
 *
 * イベントの検査に使う。オモテのサイドは位置も正体も両者へ公開されている（コア SPEC §9.3）ので、
 * それを取った `prize-taken` がカードを運ぶのは漏洩ではない。
 */
export function concealedInstanceIds(state: GameState, viewer: Viewer): Set<string> {
  const concealed = new Set<string>();
  for (const player of [0, 1] as Player[]) {
    const side = state.players[player];
    const faceUp = new Set(side.revealedPrizes);
    for (const card of side.deck) concealed.add(card.instanceId);
    for (const card of side.prizes)
      if (!faceUp.has(card.instanceId)) concealed.add(card.instanceId);
    if (player !== viewer) for (const card of side.hand) concealed.add(card.instanceId);
  }
  return concealed;
}
