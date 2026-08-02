import { expect, test, type Page } from "@playwright/test";

const SETTINGS_KEY = "love-office:web-player:settings";
const PROFILE_KEY = "love-office:web-player:profile";
const AUTOSAVE_KEY = "love-office:web-player:autosave";

async function setDeterministicSettings(page: Page, debugMode = false) {
  await page.addInitScript(({ key, debug }) => {
    localStorage.clear();
    localStorage.setItem(key, JSON.stringify({
      textSpeed: 8,
      autoDelay: 600,
      reducedMotion: true,
      debugMode: debug,
      characterX: -8,
      characterY: 8,
      characterScale: 108,
      locale: "ko",
    }));
  }, { key: SETTINGS_KEY, debug: debugMode });
}

async function enterFirstScene(page: Page) {
  await page.getByRole("button", { name: "새 게임" }).click();
  await page.getByRole("button", { name: /스토리 모드/ }).click();
  for (let step = 0; step < 30; step += 1) {
    if (await page.locator(".vn-dialogue").isVisible()) return;
    const pending = page.locator(".vn-flow-dialogue button");
    if (await pending.count()) {
      await pending.click();
      continue;
    }
    const event = page.locator(".vn-flow-option-list button:not(.pass)").first();
    if (await event.count()) {
      await event.click();
      continue;
    }
    await page.waitForTimeout(50);
  }
  throw new Error("first playable dialogue was not reached");
}

test.beforeEach(async ({ page }) => {
  await setDeterministicSettings(page);
});

test("new game is exactly the approved three-mode contract", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 게임" }).click();

  await expect(page.locator(".vn-mode-card")).toHaveCount(3);
  await expect(page.locator(".vn-mode-card h2")).toHaveText([
    "스토리 모드",
    "속마음 모드",
    "어나더 스토리",
  ]);
  await expect(page.getByText("그녀들의 일상과 속마음을 들어 보아요", { exact: true })).toBeVisible();
  await expect(page.getByText("새로운 그녀로 새로운 이야기를 만들어 보아요", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /속마음 모드/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /어나더 스토리/ })).toBeDisabled();
  await expect(page.getByText("NEW GAME", { exact: true })).toHaveCount(0);
  await expect(page.getByText("어떤 두근거림으로 시작할까요?", { exact: true })).toHaveCount(0);
  await expect(page.locator(".vn-route-screen")).toHaveScreenshot("new-game.webp");
});

test("first ending profile unlocks both post-ending modes", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      clearedRoutes: ["seo_a"],
      unlockedModes: ["base"],
      memories: [],
    }));
  }, { key: PROFILE_KEY });
  await page.goto("/");
  await page.getByRole("button", { name: "새 게임" }).click();

  await expect(page.getByRole("button", { name: /속마음 모드/ })).toBeEnabled();
  await expect(page.getByRole("button", { name: /어나더 스토리/ })).toBeEnabled();
});

test("mode selection fixes the view layer and separates coming-soon content", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      clearedRoutes: ["seo_a"],
      unlockedModes: ["base"],
      memories: [],
    }));
  }, { key: PROFILE_KEY });
  await page.goto("/");
  await page.getByRole("button", { name: "새 게임" }).click();
  await page.getByRole("button", { name: /어나더 스토리/ }).click();
  await expect(page.locator(".vn-toast")).toHaveText("어나더 스토리의 첫 장면은 준비 중이에요.");
  await expect(page.locator(".vn-route-screen")).toBeVisible();

  await page.getByRole("button", { name: /속마음 모드/ }).click();
  await expect(page.locator(".vn-game.reality")).toBeVisible();
  await expect(page.getByRole("button", { name: "주인공 인식" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "실제 시간선" })).toHaveCount(0);
});

test("game flow hides authoring UI and debug restores controlled inspection", async ({ page }) => {
  test.setTimeout(60_000);
  await setDeterministicSettings(page, true);
  await page.goto("/");
  await expect(page.locator(".vn-title-key-art")).toBeVisible();
  await enterFirstScene(page);

  await expect(page.locator(".timeline-shell, .timeline-board")).toHaveCount(0);
  await expect(page.getByText(/\bACT\s*\d+\b/i)).toHaveCount(0);
  await expect(page.getByText("17일", { exact: false })).toHaveCount(0);
  await expect(page.locator(".vn-debug-panel")).toBeVisible();
  await expect(page.locator(".vn-debug-panel input[type=range]")).toHaveCount(3);
  await expect(page.locator(".vn-debug-identity")).toContainText("MODEbase");
  await expect(page.locator(".vn-debug-identity")).toContainText("CAMPAIGNmain");
  await expect(page.locator(".vn-debug-identity")).toContainText("CONTINUITYmain");
  await expect(page.locator(".vn-debug-identity")).toContainText("LAYERperceived");
  await page.locator(".vn-mode-button").first().click();
  await expect(page.locator(".vn-debug-identity")).toContainText("LAYERperceived → reality (preview)");
  const persistedLayer = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null")?.session?.viewLayer, AUTOSAVE_KEY);
  expect(persistedLayer).toBe("perceived");
  await page.locator(".vn-mode-button").first().click();

  await expect(page.locator(".vn-nameplate")).toHaveCount(0);
  await expect(page.locator(".vn-character")).toHaveCount(0);

  let seoAReached = false;
  for (let step = 0; step < 60; step += 1) {
    const nameplate = page.locator(".vn-nameplate");
    const name = await nameplate.count() ? await nameplate.textContent() : null;
    if (name?.trim() === "윤서아") {
      seoAReached = true;
      break;
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(20);
  }
  expect(seoAReached).toBe(true);
  await expect(page.locator(".vn-character")).toHaveCount(1);
  await expect(page.locator(".vn-character img")).toHaveAttribute("alt", "윤서아");
  await expect(page.getByRole("button", { name: "← 이전 대화" }).first()).toBeEnabled();
});
