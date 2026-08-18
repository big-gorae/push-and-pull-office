import { expect, test, type Page } from "@playwright/test";
import runtimeFixture from "../build/story-runtime.json" with { type: "json" };

const dayOneOpening = runtimeFixture.scenes["common.day_01_dream_and_mother_call"];
const dayOneOpeningLine = dayOneOpening.nodes[dayOneOpening.start_node].line;
const dayOneOpeningNodeCount = dayOneOpening.node_order.length;

async function selectScene(page: Page, title: string) {
  await page.getByRole("button", { name: "날짜별 장면 열기" }).click();
  await page.getByRole("button", { name: new RegExp(title) }).click();
}

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
  await expect(page.getByRole("heading", { name: "꿈을 끊은 전화" })).toBeVisible();
  await expect(page.locator(".mobile-node-card")).toHaveCount(dayOneOpeningNodeCount);

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

test("mobile scene authoring prefers the newly deployed dialogue over a stale local and server catalog", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  const staleCatalog = await page.evaluate(async ({ sceneId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("love-office-mobile-authoring", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const snapshot = await new Promise<any>((resolve, reject) => {
      const request = db.transaction("catalog", "readonly").objectStore("catalog").get("love_office_story_1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    snapshot.generation = "a".repeat(64);
    snapshot.updatedAt = "2026-08-14T00:00:00.000Z";
    const scene = snapshot.workspace.scenes[sceneId].scene;
    scene.nodes[scene.start_node].line = "배포 전 오래된 대사";
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("catalog", "readwrite");
      transaction.objectStore("catalog").put(snapshot);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    return snapshot;
  }, { sceneId: dayOneOpening.id });
  await page.route("**/api/authoring/v1/catalog?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, catalog: staleCatalog }),
  }));

  await page.reload();
  await expect(page.locator(".node-card-main").first()).toContainText(dayOneOpeningLine);
  await expect(page.getByText("배포 전 오래된 대사", { exact: true })).toHaveCount(0);
});

test("mobile scene authoring shows new canonical dialogue while preserving an outdated phone draft", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/#/author");
  await expect(page.getByRole("heading", { name: "대사 장면 편집기" })).toBeVisible();

  await page.locator(".node-card-main").first().click();
  const editor = page.getByRole("textbox", { name: "대사" });
  await editor.fill("휴대폰에 남은 예전 초안");
  await expect(page.locator(".mobile-node-editor .scene-status", { hasText: "이 폰에 초안 저장" })).toBeVisible();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("love-office-mobile-authoring", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const drafts = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction("sceneDrafts", "readonly").objectStore("sceneDrafts").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    drafts[0].baseSceneHash = "0".repeat(64);
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("sceneDrafts", "readwrite");
      transaction.objectStore("sceneDrafts").put(drafts[0]);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });

  await page.reload();
  await expect(page.locator(".node-card-main").first()).toContainText(dayOneOpeningLine);
  await expect(page.locator(".scene-heading .scene-status", { hasText: "겹친 수정 확인" })).toBeVisible();
  await page.getByRole("button", { name: "휴대폰 초안 보기" }).click();
  await expect(page.locator(".node-card-main").first()).toContainText("휴대폰에 남은 예전 초안");
  await page.getByRole("button", { name: "최신 원문 보기" }).click();
  await expect(page.locator(".node-card-main").first()).toContainText(dayOneOpeningLine);
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
  await selectScene(page, "고양이 슬리퍼");

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
