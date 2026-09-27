/**
 * Worker にエンジンのカードデータを埋め込む Vite プラグイン（`docs/spec/battle-server.md` 8 節）。
 *
 * エンジンは `node:fs` でリポジトリの中の JSON を読むが、Worker にはそのファイルが無い。
 * エンジンのコードは変えずに、読み込む関数の中身だけをビルドのときに埋め込んだデータへ向ける。
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { CARD_DATA_PATH, engineIdentity, type EngineIdentity } from "./engine-identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** 実パスで比べる。engine/ が symlink でも、エンジンの中からの import は symlink 先のパスで届く。 */
const ENGINE_SRC = realpathSync(join(ROOT, "engine", "src")) + sep;
const CARD_LOADER = realpathSync(join(ROOT, "engine", "src", "cardpool", "generated-cards.ts"));
const EMBEDDED = "\0embedded-card-data";

const realPath = (path: string): string | null => (existsSync(path) ? realpathSync(path) : null);

export function embedCardData(identity: EngineIdentity): Plugin {
  /** 画面と Worker は別の環境としてビルドするので、差し替えた回数も分けて数える。 */
  const replaced = new Map<string, number>();
  return {
    name: "embed-card-data",
    enforce: "pre",
    buildStart() {
      replaced.set(this.environment.name, 0);
    },
    resolveId(source, importer) {
      if (importer === undefined || !source.endsWith("generated-cards.js")) return null;
      const path = resolve(dirname(importer), source.replace(/\.js$/, ".ts"));
      return realPath(path) === CARD_LOADER ? EMBEDDED : null;
    },
    load(id) {
      if (id !== EMBEDDED) return null;
      const name = this.environment.name;
      replaced.set(name, (replaced.get(name) ?? 0) + 1);
      // 解析は初めて呼ばれたときにする。起動のたびに解析すると、カードを使わない要求まで起動が遅くなる。
      return [
        "let cards;",
        "export function loadGeneratedCards() {",
        `  cards ??= JSON.parse(${JSON.stringify(identity.cardDataText)});`,
        "  return cards;",
        "}",
      ].join("\n");
    },
    /**
     * 差し替えが効かなかったら止める。エンジン側でファイルの場所が変わると、差し替えは黙って外れ、
     * Worker はリポジトリの中の JSON を読みに行く。それは動かしてみるまで分からない。
     * エンジンを取り込んだ環境だけを見る。1 か所でも元のファイルが読み込まれていれば、そこから外れている。
     */
    buildEnd(error) {
      if (error !== undefined) return;
      const ids = [...this.getModuleIds()].map(realPath);
      if (!ids.some((id) => id?.startsWith(ENGINE_SRC))) return;
      if ((replaced.get(this.environment.name) ?? 0) === 0 || ids.includes(CARD_LOADER)) {
        this.error(
          `${CARD_LOADER} を差し替えられなかった。エンジンのカードデータの読み込みが移っている。`,
        );
      }
    },
    /**
     * 埋め込む値は設定を読んだときに決まる。エンジンに手が入って値が変わったら、開発サーバごと読み直す。
     * そうしないと、手を入れたエンジンで指した対戦が手を入れる前の commit を名乗る。
     */
    configureServer(server) {
      server.watcher.add([CARD_DATA_PATH, ENGINE_SRC]);
      server.watcher.on("all", (_event, path) => {
        const inEngine = path.startsWith(ENGINE_SRC) || realPath(path)?.startsWith(ENGINE_SRC);
        if (path !== CARD_DATA_PATH && inEngine !== true) return;
        const current = engineIdentity();
        if (
          current.commit !== identity.commit ||
          current.cardDataSha256 !== identity.cardDataSha256
        ) {
          void server.restart();
        }
      });
    },
  };
}
