/**
 * 新しい画面（`web/`）が、いまの画面と同じ Worker から配られていることを見る。
 * 中身は client.spec.ts を `/next/` へ向けて確かめる。ここでは入口が描けることと、いまの画面を置き換えていないことだけを見る。
 */

import { expect, test } from "@playwright/test";
import { BASEPATH } from "../web/basepath.js";

test("新しい画面は /next/ で描け、いまの画面は / に残る", async ({ page }) => {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  await page.goto(`${BASEPATH}/`);
  await expect(page.locator("#next-home")).toBeVisible();
  await expect(page.locator("#join")).toBeVisible();

  await page.goto("/");
  await expect(page.locator("#join")).toBeVisible();
  await expect(page.locator("#next-home")).toHaveCount(0);

  expect(errors).toEqual([]);
});
