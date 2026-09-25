/**
 * HTTP で受け取る本文の形（`docs/spec/battle-server.md` 3.1 節、7.2 節）。
 *
 * **形の検査をここ 1 か所に集める。** エンドポイントごとに `typeof` を書いていたときは、
 * 口を足すたびに検査も 1 つ書く必要があり、書き忘れたぶんは「中身を触った先で落ちて、
 * その例外の文言が外へ出る」形で出ていた。ここへ集めておけば、足すのはスキーマ 1 つで済む。
 *
 * **形が違うことと、中身が規則に反することは別である。** ここが見るのは形だけで、
 * 「そのシークレットのプレイヤーがいない」「そのデッキは 60 枚でない」は通したうえで、
 * それぞれの答えを返す側が判断する。
 */

import { z } from "zod";
import type { DeckList } from "./engine.js";
import type { JoinRequest } from "./lobby.js";
import { SEED_SHARE_PATTERN } from "./fingerprint.js";
import { DECK_SIZE } from "./deck.js";

/** `CardDefId` は文字列なので、形としてはこれで足りる。枚数と構築の規則は `deck.ts` が見る。 */
export const deckListSchema = z.object({
  cards: z.array(z.string()),
}) satisfies z.ZodType<DeckList>;

/**
 * **欄が無いことと、`undefined` が入っていることを分ける。** `exactOptionalPropertyTypes`
 * が効いているので、`JoinRequest` の省ける欄に `undefined` は入れられない。Zod の
 * `.optional()` が出す型はその区別を持たないので、無い欄はここで落としてから渡す。
 */
export const joinRequestSchema = z
  .object({
    secret: z.string(),
    deck: deckListSchema,
    displayName: z.string().optional(),
    roomCode: z.string().optional(),
    seedShareCommit: z.string().regex(SEED_SHARE_PATTERN).optional(),
  })
  .transform((body): JoinRequest => ({
    secret: body.secret,
    deck: body.deck,
    ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
    ...(body.roomCode === undefined ? {} : { roomCode: body.roomCode }),
    ...(body.seedShareCommit === undefined ? {} : { seedShareCommit: body.seedShareCommit }),
  }));

/**
 * AI と対戦する要求（7.3 節）。自分のデッキは組んだもの（`deck`）か、AI と同じ表のデッキ
 * （`deckPreset`）のどちらか一方で渡す。
 */
export const joinBotRequestSchema = z
  .object({
    secret: z.string(),
    bot: z.string(),
    botDeck: z.string(),
    deck: deckListSchema.optional(),
    deckPreset: z.string().optional(),
    displayName: z.string().optional(),
    seedShareCommit: z.string().regex(SEED_SHARE_PATTERN).optional(),
  })
  .refine((body) => (body.deck === undefined) !== (body.deckPreset === undefined));

/** 自分のものを読むだけの要求。シークレットを URL に載せないので本文で受ける（7.2 節）。 */
export const secretRequestSchema = z.object({
  secret: z.string(),
});

export const replayRequestSchema = z.object({
  secret: z.string(),
  /** 名指しの形かどうか（`isMatchId`）は、404 を返す側が見る。ここでは文字列であることだけ。 */
  matchId: z.string(),
  ply: z.int().nonnegative().optional(),
});

/** 表示名は省ける。省いたときの既定は `accounts.ts` が決める。 */
export const createAccountSchema = z.object({
  displayName: z.string().optional(),
});

export const resolveDecklistSchema = z.object({
  text: z.string(),
});

/**
 * 公式サイトのデッキコードから画面が読んだカード ID と枚数。合計がデッキの枚数を越えていても
 * 読み込み、どこが多いかは検査の結果で見せる。上限は巨大な配列を作らせないためのもので、
 * 種類の数と 1 種類の枚数に置く（5.3 節の行数の上限と同じ考え）。
 */
export const officialDeckSchema = z.object({
  cards: z
    .array(
      z.object({
        cardId: z.string().regex(/^[0-9]+$/),
        count: z.int().min(1).max(DECK_SIZE),
      }),
    )
    .max(DECK_SIZE),
});
