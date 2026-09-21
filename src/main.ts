/** 起動（`docs/spec/battle-server.md` 3 節）。 */

import { createApp } from "./app.js";
import { registerPoolCards } from "./engine.js";
import { engineFingerprint } from "./fingerprint.js";

const PORT = Number(process.env.PORT ?? 8080);

/**
 * 保存先は環境変数で動かせるようにする。既定はリポジトリの `data/` だが、
 * 本番では書き込める別の場所を指すことになる。
 */
const LOG_DIR = process.env.POKE_LOG_DIR;
const ACCOUNT_DIR = process.env.POKE_ACCOUNT_DIR;

registerPoolCards();

const app = createApp({
  ...(LOG_DIR === undefined ? {} : { logDir: LOG_DIR }),
  ...(ACCOUNT_DIR === undefined ? {} : { accountDir: ACCOUNT_DIR }),
});
app.http.listen(PORT, () => {
  const engine = engineFingerprint();
  process.stdout.write(
    `対戦サーバを ${PORT} で開いた（エンジン ${engine.commit.slice(0, 12)}、` +
      `カードデータ ${engine.cardDataSha256.slice(0, 12)}）\n`,
  );
});
