import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { WatchOutcome } from "../../src/lobby.js";
import { accountKey, accountQuery, storedSecret } from "../lib/account.js";
import { messageOf, postJson } from "../lib/api.js";
import { useCardData } from "../lib/cards.js";
import { useSavedDecks } from "../lib/deck.js";
import {
  botListQuery,
  deckRequest,
  isListed,
  presetName,
  type DeckChoice,
  type DeckPreset,
} from "../lib/join.js";
import { BotDeckOptions, UntrainedDeckNote } from "./bot-deck.js";

/**
 * AI どうしの対戦を立てて、観戦の画面へ移る（仕様 7.4 節）。自分は座らないので、自分の対戦とは別に立てられる。
 *
 * 立てた対戦が終わっていなければ、サーバはその観戦トークンを返して断る。そのときもそこへ移る。
 *
 * デッキは AI と対戦する欄と同じく、学習で握った表のデッキのほかに、保存したデッキとサンプルデッキも選べる。
 */
export function BotWatchForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { table } = useCardData();
  const bots = useQuery(botListQuery);
  const botNames = bots.data?.bots ?? [];
  const decks = bots.data?.decks ?? [];
  const savedDecks = useSavedDecks().decks.data ?? [];
  const [picked, setPicked] = useState<[Pick, Pick]>([{}, {}]);
  const [status, setStatus] = useState("");
  const [requesting, setRequesting] = useState(false);

  // 選ぶまでは、AI は一覧の先頭、デッキは表の先頭と 2 番目にする。同じデッキどうしでは見比べにくい。
  // 選んだデッキが一覧から消えたら（消した保存したデッキ）、選ぶ前に戻す。
  const chosen = ([0, 1] as const).map((seat) => {
    const deck = picked[seat].deck;
    return {
      bot: picked[seat].bot ?? botNames[0]?.name ?? "",
      deck:
        deck !== undefined && isListed(deck, savedDecks, decks) ? deck : defaultDeck(decks, seat),
    };
  });
  const pick = (seat: 0 | 1, change: Pick) =>
    setPicked((current) => {
      const next: [Pick, Pick] = [current[0], current[1]];
      next[seat] = { ...current[seat], ...change };
      return next;
    });

  const start = async () => {
    setStatus("AI どうしの対戦を用意しています");
    await queryClient.fetchQuery(accountQuery());
    const secret = storedSecret();
    if (secret === null) throw new Error("プレイヤーを用意できなかった");
    const sent = await Promise.all(chosen.map((seat) => deckRequest(seat.deck, savedDecks)));
    const outcome = await postJson<WatchOutcome>("/api/watch-bots", {
      secret,
      bots: chosen.map((seat) => seat.bot),
      decks: sent.map((deck) => ("deck" in deck ? deck.deck : deck.deckPreset)),
    });
    const watch = outcome.spectatorToken;
    if (watch !== undefined) {
      await navigate({ to: "/watch/$token", params: { token: watch } });
      return;
    }
    if (!outcome.ok && outcome.code === "account-not-found") {
      void queryClient.invalidateQueries({ queryKey: accountKey, refetchType: "none" });
    }
    if (!outcome.ok) setStatus(`始められませんでした:\n${outcome.errors.join("\n")}`);
  };

  // サンプルデッキはいつも選べるので、表のデッキが無くても立てられる。
  const ready = botNames.length > 0;
  return (
    <section id="bot-watch">
      <header className="page-head">
        <div>
          <h1>観戦</h1>
          <p className="note">
            人の対戦は、指している人から観戦のリンクを受け取って開きます。ここでは AI を 2
            人選んで指させ、1 手ずつ見ます。両者の手札も見え、止めて 1
            手ずつ進めたり戻したりできます。
          </p>
        </div>
      </header>
      <output id="watch-bots-status" className="status">
        {status}
      </output>
      <section className="panel">
        <h2>AI どうしの対戦</h2>
        <div className="fields">
          {([0, 1] as const).map((seat) => (
            <fieldset key={seat} className="watch-seat">
              <legend>{seat === 0 ? "手前" : "向かい"}</legend>
              <label>
                AI
                <select
                  id={`watch-bot-${seat}`}
                  value={chosen[seat]!.bot}
                  onChange={(event) => pick(seat, { bot: event.target.value })}
                >
                  {botNames.map(({ name }) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                デッキ
                <select
                  id={`watch-deck-${seat}`}
                  value={chosen[seat]!.deck}
                  onChange={(event) => pick(seat, { deck: event.target.value as DeckChoice })}
                >
                  <BotDeckOptions
                    presets={decks}
                    saved={savedDecks}
                    presetName={(deck) => presetName(deck, table)}
                  />
                </select>
              </label>
              {/* 表が届くまでは、選んでいなくてもサンプルデッキを指している。 */}
              {bots.isSuccess && !chosen[seat]!.deck.startsWith("preset:") && (
                <p id={`watch-deck-note-${seat}`} className="note">
                  <UntrainedDeckNote
                    deck={
                      savedDecks.find(({ deckId }) => `saved:${deckId}` === chosen[seat]!.deck) ??
                      null
                    }
                  />
                </p>
              )}
            </fieldset>
          ))}
        </div>
        <div className="actions">
          <button
            id="watch-bots-button"
            className="primary"
            disabled={requesting || !ready}
            onClick={() => {
              setRequesting(true);
              start()
                .catch((error: unknown) => setStatus(`始められませんでした: ${messageOf(error)}`))
                .finally(() => setRequesting(false));
            }}
          >
            AI どうしの対戦を見る
          </button>
        </div>
      </section>
    </section>
  );
}

interface Pick {
  bot?: string;
  deck?: DeckChoice;
}

function defaultDeck(presets: readonly DeckPreset[], seat: 0 | 1): DeckChoice {
  const preset = presets[seat] ?? presets[0];
  return preset === undefined ? "sample" : `preset:${preset.label}`;
}
