import { expect, test } from "@playwright/test";

test("mobile scene authoring edits a scene and reopens its draft offline", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => { window.location.hash = "/author"; });

  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "수요일의 첫 회의" })).toBeVisible();
  await expect(page.locator(".mobile-node-card")).toHaveCount(36);

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "원문 대사" });
  const original = await editor.inputValue();
  await editor.fill(`${original} 오프라인 장면 초안`);
  await expect(page.locator(".scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();

  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();
  await page.getByRole("button", { name: "순서 편집" }).click();
  await expect(page.getByRole("button", { name: "↓ 아래로" }).first()).toBeVisible();
  await page.getByRole("button", { name: "순서 편집 끝내기" }).click();

  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return false;
    const cache = await caches.open("love-office-authoring-v5");
    const urls = (await cache.keys()).map((request) => request.url);
    return urls.some((url) => url.includes("MobileAuthoringApp-"))
      && urls.some((url) => url.includes("story-runtime-"));
  });

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
    await expect(page.locator(".scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();
    await expect(page.getByText(/오프라인 ·/)).toBeVisible();
    await page.locator(".node-card-main").first().click();
    await expect(page.getByRole("textbox", { name: "원문 대사" })).toHaveValue(`${original} 오프라인 장면 초안`);
  } finally {
    await context.setOffline(false);
  }
});

test("mobile scene authoring exposes structure, artwork and background controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  await page.getByRole("button", { name: "씬 배경 자동 선택" }).click();
  await expect(page.getByRole("dialog", { name: "씬 기본 배경 선택" })).toBeVisible();
  await page.getByRole("button", { name: "배경 선택 닫기" }).click();

  await page.locator(".node-card-main").first().click();
  await page.getByRole("button", { name: /왼쪽.*원화 선택/ }).click();
  await expect(page.getByRole("dialog", { name: "left 원화 선택" })).toBeVisible();
  await page.getByRole("button", { name: "원화 선택 닫기" }).click();

  await expect(page.getByRole("combobox", { name: "대사 또는 나레이션" })).toBeVisible();
  await page.getByRole("button", { name: "속마음" }).click();
  await expect(page.getByRole("button", { name: /속마음 대사/ })).toBeVisible();
});

test("mobile scene authoring queues a complete scene for Mac sync", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "원문 대사" });
  await editor.fill(`${await editor.inputValue()} 원격 반영 대기`);
  await page.getByRole("button", { name: "장면 저장·동기화" }).click();

  await expect(page.locator(".scene-status.pending")).toContainText("Mac 반영 대기", { timeout: 10_000 });
});
