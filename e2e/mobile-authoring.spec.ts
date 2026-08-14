import { expect, test } from "@playwright/test";

test("Mac mobile sync window returns to authoring after authentication resets the URL", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { metadata: { currentWindow: { label: "mobile-sync" } } },
    });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
});

test("mobile scene authoring edits a scene and reopens its draft offline", async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.evaluate(() => { window.location.hash = "/author"; });

  await expect(page).toHaveTitle("office");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "수요일의 첫 회의" })).toBeVisible();
  await expect(page.locator(".mobile-node-card")).toHaveCount(20);

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "대사" });
  const original = await editor.inputValue();
  await editor.fill(`${original} 오프라인 장면 초안`);
  await expect(page.locator(".mobile-node-editor .scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();

  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();
  await page.getByRole("button", { name: "순서 편집" }).click();
  await expect(page.getByRole("button", { name: "↓ 아래로" }).first()).toBeVisible();
  await page.getByRole("button", { name: "순서 편집 끝내기" }).click();

  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return false;
    const cacheNames = (await caches.keys()).filter((name) => name.startsWith("love-office-authoring-"));
    const urls = (await Promise.all(cacheNames.map(async (name) => (await (await caches.open(name)).keys()).map((request) => request.url)))).flat();
    return urls.some((url) => url.includes("MobileAuthoringApp-"))
      && urls.some((url) => url.includes("story-runtime-"));
  });

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
    await expect(page.locator(".scene-heading .scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();
    await expect(page.getByText(/오프라인 ·/)).toBeVisible();
    await page.locator(".node-card-main").first().click();
    await expect(page.getByRole("textbox", { name: "대사" })).toHaveValue(`${original} 오프라인 장면 초안`);
  } finally {
    await context.setOffline(false);
  }
});

test("mobile scene authoring detects a new app version without touching drafts", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.route("**/app-version.json?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ buildId: "future-build-20260814", assets: [] }),
  }));
  await page.goto("/#/author");

  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "대사" });
  const original = await editor.inputValue();
  await editor.fill(`${original} 업데이트 보존 확인`);
  await expect(page.locator(".mobile-node-editor .scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();
  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();

  await expect(page.getByText("새 버전이 있습니다.")).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole("button", { name: "최신 버전 불러오기" })).toBeVisible();
  await page.locator(".node-card-main").first().click();
  await expect(page.getByRole("textbox", { name: "대사" })).toHaveValue(`${original} 업데이트 보존 확인`);

  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();
  await page.getByRole("button", { name: "날짜별 장면 열기" }).click();
  await expect(page.getByRole("button", { name: "최신 버전 확인" })).toBeVisible();
  await expect(page.getByRole("button", { name: "강제 갱신" })).toBeVisible();
  await expect(page.getByText(/현재 [A-Za-z0-9._-]+/)).toBeVisible();
});

test("mobile scene authoring force refreshes the current build and keeps drafts", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "대사" });
  const original = await editor.inputValue();
  await editor.fill(`${original} 강제 갱신 보존 확인`);
  await expect(page.locator(".mobile-node-editor .scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();
  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();
  await page.getByRole("button", { name: "날짜별 장면 열기" }).click();
  await page.getByRole("button", { name: "강제 갱신", exact: true }).click();

  await expect(page).toHaveURL(/app-reload=\d+.*#\/author/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();
  await page.locator(".node-card-main").first().click();
  await expect(page.getByRole("textbox", { name: "대사" })).toHaveValue(`${original} 강제 갱신 보존 확인`);
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
  await expect(page.getByRole("textbox", { name: "대사" })).toBeVisible();
});

test("iPhone 16 Pro Max opens dialogue editing as an isolated page", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  const target = page.locator(".node-card-main").nth(12);
  await target.scrollIntoViewIfNeeded();
  const listScrollY = await page.evaluate(() => window.scrollY);
  await target.click();

  await expect(page.locator(".mobile-node-editor.open")).toBeVisible();
  await expect(page.locator(".mobile-node-sequence")).toBeHidden();
  await expect(page.locator(".mobile-authoring-header")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator(".mobile-node-editor.open").evaluate((element) => getComputedStyle(element).position)).toBe("relative");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "대사 목록으로 돌아가기" }).click();
  await expect(page.locator(".mobile-node-sequence")).toBeVisible();
  await expect(page.locator(".mobile-authoring-header")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(listScrollY);
});

test("mobile scene authoring queues a complete scene for Mac sync", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "대사" });
  await editor.fill(`${await editor.inputValue()} 원격 반영 대기`);
  await page.getByRole("button", { name: "장면 저장·동기화" }).click();

  await expect(page.locator(".mobile-node-editor .scene-status.pending")).toContainText("Mac 반영 대기", { timeout: 10_000 });
});
