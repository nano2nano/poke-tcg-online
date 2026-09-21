/** 起動（`docs/spec/battle-server.md` 3 節）。 */

import { createApp } from "./app.js";
import { registerPoolCards } from "./engine.js";
import { engineFingerprint } from "./fingerprint.js";

const PORT = Number(process.env.PORT ?? 8080);

registerPoolCards();

const app = createApp();
app.http.listen(PORT, () => {
  const engine = engineFingerprint();
  process.stdout.write(
    `対戦サーバを ${PORT} で開いた（エンジン ${engine.commit.slice(0, 12)}、` +
      `カードデータ ${engine.cardDataSha256.slice(0, 12)}）\n`,
  );
});
