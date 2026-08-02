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
  await expect(page.locator(".vn-authoring-button, .vn-authoring-undo, .vn-screen-authoring")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "대사 편집" })).toHaveCount(0);
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

test("Tauri authoring edits composed sources, creates a translation, and exposes guarded undo", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(({ settingsKey }) => {
    localStorage.clear();
    localStorage.setItem(settingsKey, JSON.stringify({
      textSpeed: 8,
      autoDelay: 600,
      reducedMotion: true,
      debugMode: true,
      characterX: -8,
      characterY: 8,
      characterScale: 108,
      locale: "ko",
    }));
    sessionStorage.setItem("love-office:authoring-root", "/mock/love-office");
    const translations: Record<string, string> = {};
    const sources: Record<string, string> = {};
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let revision = 1;
    (window as unknown as { __authoringCalls: typeof calls }).__authoringCalls = calls;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "get_story_text_owner") {
          const key = String(args.localizationKey);
          const locale = String(args.locale || "ko");
          sources[key] ||= `한국어 원문 · ${key}`;
          if (locale === "en") {
            const translationExists = key in translations;
            const currentValue = translations[key] || sources[key];
            return {
              key,
              kind: "direct_yaml",
              editable: true,
              locale,
              isTranslation: true,
              translationExists,
              sourceValue: sources[key],
              currentValue,
              revision: `en-${revision}`,
              currentValueHash: `hash-${currentValue}`,
              relativePath: "story/locales/en.yaml",
              fieldPath: `strings.${key}`,
              sources: [{
                label: "en 번역 YAML",
                relativePath: "story/locales/en.yaml",
                fieldPath: `strings.${key}`,
                line: 12,
                column: 3,
              }],
            };
          }
          const layer = key.includes(".reality.") ? "reality" : "perceived";
          return {
            key,
            kind: "composed_template",
            editable: false,
            locale,
            reason: "MULTIPLE_SOURCE_OWNERS",
            currentValue: sources[key],
            sources: [{
              label: "장면 공통 문장",
              relativePath: "story/scenes/common/day_01_morning_briefing.yaml",
              fieldPath: `nodes.opening.self_development_template.${layer}.line`,
              line: layer === "reality" ? 52 : 45,
              column: 7,
              editable: true,
              currentValue: "오늘도 잘 부탁합니다. {{office_pitch}} 참석자표부터 볼까요?",
              revision: `scene-${revision}`,
              currentValueHash: `scene-hash-${layer}`,
              placeholders: ["office_pitch"],
            }, {
              label: "workout · office_pitch",
              relativePath: "story/manifest.yaml",
              fieldPath: "self_development.conversation_topics.workout.slots.office_pitch",
              line: 269,
              column: 9,
              editable: true,
              currentValue: "요즘 운동을 다시 시작했습니다.",
              revision: `manifest-${revision}`,
              currentValueHash: "manifest-hash",
              placeholders: [],
            }],
          };
        }
        if (command === "save_story_text") {
          const edits = args.edits as Array<{
            localization_key: string;
            locale?: string;
            next_value?: string;
            delete?: boolean;
          }>;
          const changes = edits.map((edit) => {
            const beforeExists = edit.localization_key in translations;
            const beforeValue = translations[edit.localization_key] || sources[edit.localization_key];
            if (edit.delete) delete translations[edit.localization_key];
            else if (edit.next_value) translations[edit.localization_key] = edit.next_value;
            return {
              localizationKey: edit.localization_key,
              locale: edit.locale,
              relativePath: "story/locales/en.yaml",
              fieldPath: `strings.${edit.localization_key}`,
              beforeValue,
              beforeExists,
              afterValue: edit.next_value,
              afterExists: !edit.delete,
              sourceEdit: false,
            };
          });
          revision += 1;
          return {
            saved: true,
            issues: [],
            changes,
            runtime: {
              localization: {
                default_locale: "ko",
                source_strings: sources,
                catalogs: { en: translations },
                resolved_catalogs: { en: { ...sources, ...translations } },
              },
            },
          };
        }
        return undefined;
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,
    };
  }, { settingsKey: SETTINGS_KEY });

  await page.goto("/#/play?authoring=1");
  await enterFirstScene(page);
  await page.getByRole("button", { name: "대사 편집" }).click();

  await expect(page.getByRole("dialog", { name: "인게임 원본 문구 편집" })).toBeVisible();
  await expect(page.getByText("합성 원본 구조화 편집", { exact: true })).toBeVisible();
  await expect(page.locator(".vn-composed-source-editor textarea")).toHaveCount(3);
  await expect(page.getByText(/:45:7 · nodes\.opening\.self_development_template\.perceived\.line/)).toBeVisible();

  await page.getByRole("button", { name: /English 번역/ }).click();
  await expect(page.getByText("en 새 번역", { exact: true })).toHaveCount(2);
  const translation = page.locator(".vn-story-editor > section textarea").first();
  await translation.fill("Edited English dialogue");
  await page.getByRole("button", { name: /en 번역 저장/ }).click();
  await expect(page.getByText(/실제 원본과 현재 게임 화면에 반영/)).toBeVisible();

  await page.locator(".vn-modal > header button").click();
  await expect(page.getByRole("button", { name: /마지막 문구 저장 취소/ })).toBeVisible();
  await page.getByRole("button", { name: /마지막 문구 저장 취소/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    __authoringCalls: Array<{ command: string }>;
  }).__authoringCalls.filter((call) => call.command === "save_story_text").length)).toBe(2);
  await expect(page.getByText("마지막 문구 저장을 실제 원본과 화면에서 되돌렸습니다.", { exact: true })).toBeVisible();

  const savedEdits = await page.evaluate(() => (window as unknown as {
    __authoringCalls: Array<{ command: string; args: { edits?: Array<{ delete?: boolean }> } }>;
  }).__authoringCalls.filter((call) => call.command === "save_story_text").map((call) => call.args.edits));
  expect(savedEdits).toHaveLength(2);
  expect(savedEdits[0]?.[0]?.delete).not.toBe(true);
  expect(savedEdits[1]?.[0]?.delete).toBe(true);
});
