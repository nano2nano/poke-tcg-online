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

/** これも `src/index.ts` が公開していない。対戦準備で、ベンチの枠をエンジンと同じ値で出すのに要る。 */
export { benchCapacity } from "../engine/src/engine/query.js";
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
/** テストが世代 0 の重みを作るのに使う。サーバは重みを作らない。 */
export { encodePpoWeights, newPpoWeightsFile } from "../engine/src/learning/ppo-net.js";
export { sampleFrom, softmax, type ScoredPolicy } from "../engine/src/learning/policy.js";
/** 学習と評価に使っているデッキ。AI の座席はこれを握る（7.3 節）。 */
export { metaDecks } from "../engine/harness/meta-decks.js";
