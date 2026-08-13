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

async function setAuthoringPreviewTarget(page: Page, target: Record<string, unknown>) {
  await page.addInitScript(({ previewTarget }) => {
    sessionStorage.setItem("love-office:authoring-root", "/mock/love-office");
    localStorage.setItem("love-office:authoring-preview-target", JSON.stringify(previewTarget));
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async () => undefined,
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,
    };
  }, { previewTarget: target });
}

test.beforeEach(async ({ page }) => {
  await setDeterministicSettings(page);
});

test("new game is exactly the approved two-mode contract", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "새 게임" }).click();

  await expect(page.locator(".vn-mode-card")).toHaveCount(2);
  await expect(page.locator(".vn-mode-card h2")).toHaveText([
    "스토리 모드",
    "어나더 스토리",
  ]);
  await expect(page.getByText("새로운 그녀로 새로운 이야기를 만들어 보아요", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /어나더 스토리/ })).toBeDisabled();
  await expect(page.getByText("NEW GAME", { exact: true })).toHaveCount(0);
  await expect(page.getByText("어떤 두근거림으로 시작할까요?", { exact: true })).toHaveCount(0);
  await expect(page.locator(".vn-route-screen")).toHaveScreenshot("new-game.webp");
});

test("gallery shows collected artwork and keeps stat-event artwork locked", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /갤러리/ }).click();

  const gallery = page.getByRole("dialog", { name: "원화 갤러리" });
  await expect(gallery).toBeVisible();
  await expect(gallery.getByText("수집 1 / 5", { exact: true })).toBeVisible();
  await expect(gallery.getByRole("img", { name: "러브 오피스 라인업" })).toBeVisible();
  await expect(gallery.getByRole("button", { name: "미해금 원화" })).toHaveCount(4);
});

test("gallery restores a stat-event CG from the persistent profile", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      clearedRoutes: [],
      unlockedModes: ["base"],
      memories: ["cg.stat.humor.seo_a"],
    }));
  }, { key: PROFILE_KEY });
  await page.goto("/");
  await page.getByRole("button", { name: /갤러리/ }).click();

  const gallery = page.getByRole("dialog", { name: "원화 갤러리" });
  await expect(gallery.getByText("수집 2 / 5", { exact: true })).toBeVisible();
  await gallery.getByRole("button", { name: "윤서아 — 웃음이 터진 순간" }).click();
  await expect(gallery.getByRole("img", { name: "윤서아 — 웃음이 터진 순간" })).toBeVisible();
});

test("first ending profile unlocks Another Story", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    localStorage.setItem(key, JSON.stringify({
      clearedRoutes: ["seo_a"],
      unlockedModes: ["base"],
      memories: [],
    }));
  }, { key: PROFILE_KEY });
  await page.goto("/");
  await page.getByRole("button", { name: "새 게임" }).click();

  await expect(page.getByRole("button", { name: /어나더 스토리/ })).toBeEnabled();
});

test("mode selection keeps coming-soon content separate", async ({ page }) => {
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

  await expect(page.getByRole("button", { name: "주인공 인식" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "실제 시간선" })).toHaveCount(0);
});

test("game flow hides authoring UI and debug restores controlled inspection", async ({ page }) => {
  test.setTimeout(60_000);
  await setDeterministicSettings(page, true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "office" })).toBeVisible();
  await expect(page.locator(".vn-title-key-art")).toHaveCount(0);
  await expect(page.getByText("네 사람과 마주치는 순간", { exact: false })).toHaveCount(0);
  await enterFirstScene(page);

  await expect(page.locator(".timeline-shell, .timeline-board")).toHaveCount(0);
  await expect(page.getByText(/\bACT\s*\d+\b/i)).toHaveCount(0);
  await expect(page.getByText("17일", { exact: false })).toHaveCount(0);
  await expect(page.locator(".vn-debug-panel")).toBeVisible();
  await expect(page.locator(".vn-debug-panel input[type=range]")).toHaveCount(3);
  await expect(page.locator(".vn-debug-identity")).toContainText("MODEbase");
  await expect(page.locator(".vn-debug-identity")).toContainText("CAMPAIGNmain");
  await expect(page.locator(".vn-debug-identity")).toContainText("CONTINUITYmain");
  await expect(page.locator(".vn-authoring-button, .vn-authoring-undo, .vn-screen-authoring")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "대사 편집" })).toHaveCount(0);
  const persistedLayer = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null")?.session?.viewLayer, AUTOSAVE_KEY);
  expect(persistedLayer).toBeUndefined();

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

test("authoring preview opens an exact night-activity result in its game screen", async ({ page }) => {
  await setAuthoringPreviewTarget(page, {
    kind: "system_flow",
    flowId: "system.night_activity",
    nodeId: "activity_result",
    variantId: "ott",
  });
  await page.goto("/#/play?authoring=1");

  await expect(page.locator(".vn-night-story")).toBeVisible();
  await expect(page.getByText(/한 편만 보려 했는데 벌써 세 편이네/)).toBeVisible();
});

test("authoring preview opens an exact psychology-instructor direction in context", async ({ page }) => {
  await setAuthoringPreviewTarget(page, {
    kind: "system_flow",
    flowId: "system.analysis_hint",
    nodeId: "lesson",
    variantId: "pull",
  });
  await page.goto("/#/play?authoring=1");

  await expect(page.locator(".vn-analysis-instructor")).toBeVisible();
  await expect(page.locator(".vn-analysis-instructor strong")).toContainText("대화를 이어 가야 합니다");
});

test("officetel dialogue keeps Han Do-yoon off screen and centers the other character", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await enterFirstScene(page);

  let reached = false;
  for (let step = 0; step < 240; step += 1) {
    const title = await page.locator(".vn-day small").textContent().catch(() => null);
    if (title?.trim() === "엘리베이터 문이 열리자" && await page.locator('.vn-character img[alt="윤서아"]').count() === 1) {
      reached = true;
      break;
    }
    const pending = page.locator(".vn-flow-dialogue button").first();
    if (await pending.count()) await pending.click();
    else await page.keyboard.press("Enter");
    await page.waitForTimeout(15);
  }
  expect(reached).toBe(true);

  await expect(page.locator(".vn-stage-bg")).toHaveAttribute("src", /elevator-lobby-evening/);
  await expect(page.locator('.vn-character img[alt="한도윤"]')).toHaveCount(0);
  await expect(page.locator(".vn-character.center img")).toHaveAttribute("alt", "윤서아");
  await expect(page.locator(".vn-character.speaking")).toHaveCount(1);

  let doYoonSpeaking = false;
  for (let step = 0; step < 12; step += 1) {
    if ((await page.locator(".vn-nameplate").textContent().catch(() => null))?.trim() === "한도윤") {
      doYoonSpeaking = true;
      break;
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(15);
  }
  expect(doYoonSpeaking).toBe(true);
  await expect(page.locator('.vn-character img[alt="한도윤"]')).toHaveCount(0);
  await expect(page.locator(".vn-character")).toHaveCount(0);
});

test("Tauri authoring edits direct physical sources, creates a translation, and exposes guarded undo", async ({ page }) => {
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
          return {
            key,
            kind: "direct_yaml",
            editable: true,
            locale,
            currentValue: sources[key],
            revision: `scene-${revision}`,
            currentValueHash: "scene-hash-line",
            relativePath: "story/scenes/common/day_01_company_meeting.yaml",
            fieldPath: "nodes.opening.line",
            sources: [{
              label: "원본 YAML",
              relativePath: "story/scenes/common/day_01_company_meeting.yaml",
              fieldPath: "nodes.opening.line",
              line: 45,
              column: 7,
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
  await expect(page.getByText("직접 편집", { exact: true })).toHaveCount(1);
  await expect(page.locator(".vn-story-editor > section textarea")).toHaveCount(1);
  await expect(page.getByText(/:45:7 · nodes\.opening\.line/)).toBeVisible();

  await page.getByRole("button", { name: /English 번역/ }).click();
  await expect(page.getByText("en 새 번역", { exact: true })).toHaveCount(1);
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
