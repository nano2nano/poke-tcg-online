import type { Notice } from "./describe.js";

export type LogLine = Notice & { id: number };

/** 対戦ログの 1 つのまとまり。見出しの行と、その効果で起きたことの行（古い順）。 */
export type LogEntry = LogLine & { details: LogLine[] };

/**
 * 対戦ログ（新しいまとまりが先頭）へ、届いた順の行を足す。見出しではない行は、いちばん新しいまとまりが
 * 見出しで始まっていればその下へ、そうでなければ 1 行だけのまとまりにする。
 *
 * `alone` の行は、どれも 1 行だけのまとまりにする。終わったことや手が通らなかったことなど、盤面の
 * イベントではない知らせを、そのとき開いている見出しの効果で起きたことに見せない。
 */
export function appendToLog(
  log: readonly LogEntry[],
  notices: readonly Notice[],
  alone = false,
): LogEntry[] {
  const [newest, ...older] = log;
  // 古い順に積んでから、新しいものを先頭へ並べ直す。
  const entries = newest === undefined ? [] : [{ ...newest, details: [...newest.details] }];
  let id = newest?.details.at(-1)?.id ?? newest?.id ?? 0;
  for (const notice of notices) {
    const line = { ...notice, id: (id += 1) };
    const last = entries.at(-1);
    if (!alone && last?.opens === true && notice.opens !== true) {
      // 山札を見てから取り出したなら、見たことは言わなくても分かる。取り出した行だけを残す。
      if (line.deckTaken !== undefined) {
        last.details = last.details.filter((seen) => seen.deckSeen !== line.deckTaken);
      }
      last.details.push(line);
    } else entries.push({ ...line, details: [] });
  }
  return [...entries.reverse(), ...older];
}
