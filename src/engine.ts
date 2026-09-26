/**
 * エンジンへの入口を 1 箇所へ集める。
 *
 * エンジンは git submodule（`engine/`）として取り込んでいる。取り込み方を変えるとき
 * （npm パッケージへ移すなど）に直すのはこのファイルだけで済むよう、
 * `engine/` 配下への import をサーバのほかのファイルへ散らさない。
 *
 * submodule を選んだ理由は `docs/spec/battle-server.md` 8 節にある。
 */

export {
  applyMove,
  availableAttacks,
  createGame,
  getCardDef,
  isBasicPokemon,
  legalMoves,
  movesEqual,
  opponent,
  playerView,
  projectEvents,
  spectatorView,
  IllegalMoveError,
} from "../engine/src/index.js";

/**
 * `src/index.ts` が公開していない 2 つ。デッキ構築の制約を見るのに要る
 * （エンジンはデッキ構築バリデーションを持たないので、公開 API にも無い）。
 */
export {
  entersPlayOnlyViaEffect,
  hasSetupActiveOverrideAbility,
  isAceSpec,
  stadiumHalfOf,
} from "../engine/src/cards.js";
export type { CardDef } from "../engine/src/cards.js";

export type {
  ApplyResult,
  CardDefId,
  CardInstance,
  Choice,
  ChoiceAnswer,
  DeckList,
  DomainEvent,
  GameOutcome,
  GameState,
  InPlayId,
  Move,
  Player,
  PlayerEvent,
  PlayerView,
  SpectatorView,
  Viewer,
  Zone,
} from "../engine/src/index.js";

/**
 * これも `src/index.ts` が公開していない。対戦準備で、ベンチの枠をエンジンと同じ値で出すのと、
 * 選択の候補のゾーンをエンジンと同じ読み方で引くのに要る。
 */
export { benchCapacity, cardsInZone } from "../engine/src/engine/query.js";
export { classifyDefId, listUnimplementedDefIds } from "../engine/src/coverage.js";
export { registerPoolCards } from "../engine/src/cardpool/index.js";
export { loadGeneratedCards } from "../engine/src/cardpool/generated-cards.js";
export { createRng, nextInt } from "../engine/src/rng.js";

/**
 * 学習した方策を AI の座席に座らせるのに要る（7.3 節）。どれも `src/index.ts` が公開していない。
 * 重みの形式の見分け方と読み方はエンジンの `readWeightsFile` と同じで、ファイルのパスの代わりにバイト列を受ける。
 */
export { policyOf, type PolicyFile } from "../engine/src/learning/residual.js";
export { decodePpoWeights, PPO_MAGIC } from "../engine/src/learning/ppo-net.js";
export { decodeEntityWeights, ENTITY_MAGIC } from "../engine/src/learning/entity-net.js";
/** テストが世代 0 の重みを作るのに使う。サーバは重みを作らない。 */
export { encodePpoWeights, newPpoWeightsFile } from "../engine/src/learning/ppo-net.js";
export { encodeEntityWeights, newEntityWeightsFile } from "../engine/src/learning/entity-net.js";
export { sampleFrom, type DecisionExtras } from "../engine/src/learning/policy.js";
export {
  GameKnowledge,
  NO_KNOWLEDGE,
  tracksKnowledge,
  type HiddenKnowledge,
} from "../engine/src/knowledge/seat-knowledge.js";
/** テストが、サーバとは別の道で AI の座席の知識を求め直すのに使う。 */
export { SeatKnowledge } from "../engine/src/knowledge/seat-knowledge.js";
/** 座席の方策が候補ごとに付ける確率。エンジンの自己対戦と同じ分布を返すので、AI の座席もここから引く。 */
export { probabilitiesOf } from "../engine/harness/seat-agent.js";
/**
 * AI の座席の方策へ、自己対戦が渡すのと同じ入力と候補を渡すのに要る。導出値は座席ごとの照会で、
 * 局面の記録は同じ番で既に来た局面へ戻る手を候補から外すのに使う。
 */
export { derivedView } from "../engine/src/engine/derivedView.js";
export { RevisitTracker } from "../engine/src/testing/revisit.js";
/** テストが、サーバとは別の道で AI の座席の候補を求め直すのに使う。 */
export { positionKey } from "../engine/src/testing/revisit.js";
/** 学習と評価に使っているデッキ。AI の座席はこれを握る（7.3 節）。 */
export { metaDecks } from "../engine/harness/meta-decks.js";
