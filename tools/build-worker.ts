/**
 * Worker に載せる 1 本の JavaScript を作る。`wrangler dev` と `wrangler deploy` がこれを先に呼ぶ
 * （`wrangler.jsonc` の `build`）。
 *
 * wrangler の組み立てだけで済ませないのは、エンジンのカードデータの読み込みを差し替えるためである。
 * エンジンは `node:fs` でリポジトリの中の JSON を読むが、Worker にはそのファイルが無い。
 * エンジンのコードは変えずに、読み込む関数の中身だけをビルドのときに埋め込んだデータへ向ける。
 */

import { build, type Plugin } from "esbuild";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cardIdsOf, engineIdentity } from "./engine-identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CARD_LOADER = join(ROOT, "engine", "src", "cardpool", "generated-cards.ts");

const identity = engineIdentity();
let replaced = 0;

/**
 * エンジンの `loadGeneratedCards` を、埋め込んだデータを返す関数に差し替える。
 * 読み込みは初めて呼ばれたときにする。起動のたびに解析すると、カードを使わない
 * 要求まで起動が遅くなる。
 */
const embedCardData: Plugin = {
  name: "embed-card-data",
  setup(builder) {
    builder.onResolve({ filter: /generated-cards\.js$/ }, (args) => {
      const path = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return path === CARD_LOADER ? { path, namespace: "embedded-card-data" } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: "embedded-card-data" }, () => {
      replaced += 1;
      return {
        loader: "js",
        contents: [
          "let cards;",
          "export function loadGeneratedCards() {",
          `  cards ??= JSON.parse(${JSON.stringify(identity.cardDataText)});`,
          "  return cards;",
          "}",
        ].join("\n"),
      };
    });
  },
};

const OUTFILE = join(ROOT, "dist", "worker.js");

const result = await build({
  entryPoints: [join(ROOT, "src", "worker.ts")],
  outfile: OUTFILE,
  write: false,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  // Node の組み込みと Workers の組み込みは、実行時に Workers が差し出す（`nodejs_compat`）。
  external: ["node:*", "cloudflare:*"],
  define: {
    __ENGINE_COMMIT__: JSON.stringify(identity.commit),
    __CARD_DATA_SHA256__: JSON.stringify(identity.cardDataSha256),
    __CARD_IDS__: JSON.stringify(cardIdsOf(identity.cardDataText)),
  },
  plugins: [embedCardData],
  logLevel: "warning",
});

/**
 * **差し替えが効かなかったら止める。** エンジン側でファイルの場所が変わると、差し替えは黙って外れ、
 * Worker はリポジトリの中の JSON を読みに行く。それは動かしてみるまで分からない。
 */
if (replaced === 0) {
  throw new Error(
    `${CARD_LOADER} を差し替えられなかった。エンジンのカードデータの読み込みが移っている。`,
  );
}

/**
 * 別名で書いてから差し替える。テストは Worker を並べて起こし、そのたびにここを通る。
 * 書いている途中のファイルを別の Worker が読むと、途中で切れたコードを読み込んで起動に落ちる。
 */
mkdirSync(dirname(OUTFILE), { recursive: true });
const temporary = `${OUTFILE}.${process.pid}.tmp`;
writeFileSync(temporary, result.outputFiles[0]!.contents);
renameSync(temporary, OUTFILE);
