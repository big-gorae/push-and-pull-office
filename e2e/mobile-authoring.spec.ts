import { expect, test } from "@playwright/test";

test("mobile authoring reopens offline with its locally saved draft", async ({ page, context }) => {
  await page.goto("/author/");
  await expect(page.getByRole("heading", { name: "대사 보관함" })).toBeVisible();
  await expect(page.locator(".dialogue-card").first()).toBeVisible();

  await page.locator(".dialogue-card").first().click();
  const editor = page.getByRole("textbox", { name: "수정할 문장" });
  const original = await editor.inputValue();
  await editor.fill(`${original} 오프라인 초안`);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "편집 닫기" }).click();
  await expect(page.getByRole("button", { name: /내 수정 1/ })).toBeVisible();

  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return false;
    const cache = await caches.open("love-office-authoring-v3");
    const urls = (await cache.keys()).map((request) => request.url);
    return urls.some((url) => url.includes("MobileAuthoringApp-"))
      && urls.some((url) => url.includes("story-runtime-"));
  });

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "대사 보관함" })).toBeVisible();
    await expect(page.getByRole("button", { name: /내 수정 1/ })).toBeVisible();
    await expect(page.getByText(/오프라인 ·/)).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});
