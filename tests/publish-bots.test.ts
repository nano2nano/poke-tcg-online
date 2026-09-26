/** 学習の走りの方策を AI の座席へ上げる道具（`tools/publish-bots.ts`）。 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeEntityWeights,
  encodePpoWeights,
  newEntityWeightsFile,
  newPpoWeightsFile,
} from "../src/engine.js";
import { checkLoads, plan, readRunPointers, RUN_STATE } from "../tools/publish-bots.js";
import { ensureCards } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runDir(state: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-bots-"));
  dirs.push(dir);
  writeFileSync(join(dir, RUN_STATE), JSON.stringify(state));
  return dir;
}

const pointers = {
  gate: "measure" as const,
  current: "ppo-clip-g23.weights",
  anchors: [0, 5, 10, 15, 20, 23].map((generation) => ({
    generation,
    weights: `ppo-clip-g${generation}.weights`,
  })),
};

describe("走りの状態", () => {
  it("いまの方策と凍結した世代を読む", () => {
    const dir = runDir({
      version: 4,
      config: { gate: "measure", trust: "clip" },
      attempts: 30,
      current: { weights: pointers.current, adam: null },
      anchors: pointers.anchors,
    });
    expect(readRunPointers(dir)).toEqual(pointers);
  });

  it("いまの方策が無い状態は読まない", () => {
    expect(() => readRunPointers(runDir({ config: { gate: "filter" }, anchors: [] }))).toThrow(
      /current\.weights/,
    );
  });

  it("ゲートの扱いが分からない状態は読まない", () => {
    expect(() =>
      readRunPointers(runDir({ current: { weights: pointers.current }, anchors: [] })),
    ).toThrow(/config\.gate/);
  });
});

describe("上げるもの", () => {
  const sha = (weights: string) => `sha-of-${weights}`;
  const options = { name: "learning", keepEvery: 10 };

  it("残す世代を先に、いまの方策を最後に並べる", () => {
    expect(plan(pointers, sha, new Map(), options)).toEqual([
      { name: "learning-g0", weights: "ppo-clip-g0.weights" },
      { name: "learning-g10", weights: "ppo-clip-g10.weights" },
      { name: "learning-g20", weights: "ppo-clip-g20.weights" },
      { name: "learning", weights: "ppo-clip-g23.weights" },
    ]);
  });

  it("同じ中身を上げた名前は上げ直さない。いまの方策が変われば上げる", () => {
    const published = new Map([
      ["learning-g0", sha("ppo-clip-g0.weights")],
      ["learning-g10", sha("ppo-clip-g10.weights")],
      ["learning-g20", sha("ppo-clip-g20.weights")],
      ["learning", sha("ppo-clip-g20.weights")],
    ]);
    expect(plan(pointers, sha, published, options)).toEqual([
      { name: "learning", weights: "ppo-clip-g23.weights" },
    ]);
    published.set("learning", sha("ppo-clip-g23.weights"));
    expect(plan(pointers, sha, published, options)).toEqual([]);
  });

  it("--keep-every=0 なら、いまの方策だけを上げる", () => {
    expect(plan(pointers, sha, new Map(), { name: "learning", keepEvery: 0 })).toEqual([
      { name: "learning", weights: "ppo-clip-g23.weights" },
    ]);
  });
});

describe("上げる前の読み込み", () => {
  it("形式 5 と形式 6 の重みを読んで 1 手選ぶ", () => {
    ensureCards();
    const ppo = checkLoads("p", encodePpoWeights(newPpoWeightsFile("test-ppo")));
    expect(ppo.identity.label).toBe("test-ppo");
    const entity = checkLoads("e", encodeEntityWeights(newEntityWeightsFile("test-entity")));
    expect(entity.identity.label).toBe("test-entity");
  });

  it("語彙が違うエンジンで作った重みは読まない", () => {
    ensureCards();
    const file = newEntityWeightsFile("test-entity");
    const vocabulary = { ...file.vocabulary, sub: [...file.vocabulary.sub.slice(0, -1), "無い語"] };
    expect(() => checkLoads("e", encodeEntityWeights({ ...file, vocabulary }))).toThrow();
  });
});
