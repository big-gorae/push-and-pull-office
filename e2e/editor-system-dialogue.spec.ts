import { expect, test } from "@playwright/test";
import runtimeFixture from "../build/story-runtime.json" with { type: "json" };

test("system dialogue workspace is navigable, safe while saving, and undoable", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(({ runtimeSource }) => {
    localStorage.clear();
    localStorage.setItem("love-office:last-workspace", "system");
    let runtime = structuredClone(runtimeSource) as typeof runtimeSource;
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    let revision = 1;
    const meta = (path: string) => ({ path, revision: `revision-${revision}`, source: "" });
    const documents = {
      campaigns: Object.fromEntries(Object.keys(runtime.campaigns).map((id) => [id, meta(`story/campaigns/${id}.yaml`)])),
      characters: Object.fromEntries(Object.keys(runtime.characters).map((id) => [id, meta(`story/characters/${id}.yaml`)])),
      events: Object.fromEntries(Object.keys(runtime.events).map((id) => [id, meta(`story/events/${id}.yaml`)])),
      locales: Object.fromEntries(Object.keys(runtime.localization.locales).map((id) => [id, meta(`story/locales/${id}.yaml`)])),
      visuals: Object.fromEntries(Object.keys(runtime.visuals).map((id) => [id, meta(`story/visuals/${id}.yaml`)])),
      threads: Object.fromEntries(Object.keys(runtime.threads).map((id) => [id, meta(`story/threads/${id}.yaml`)])),
      meta: Object.fromEntries(Object.keys(runtime.meta).map((id) => [id, meta(`story/meta/${id}.yaml`)])),
      routes: Object.fromEntries(Object.keys(runtime.routes).map((id) => [id, meta(`story/routes/${id}.yaml`)])),
      scenes: Object.fromEntries(Object.entries(runtime.scenes).map(([id, scene]) => [id, meta((scene as { source?: string }).source || `story/scenes/${id}.yaml`)])),
      system_flows: Object.fromEntries(Object.keys(runtime.system_flows).map((id) => [id, meta(`story/system_flows/${id.split(".").at(-1)}.yaml`)])),
    };
    const owner = (key: string) => {
      const entry = runtime.localization.entries[key];
      const currentValue = entry.source;
      return {
        key,
        kind: "direct_yaml",
        editable: true,
        currentValue,
        revision: `revision-${revision}`,
        currentValueHash: `hash-${revision}-${currentValue}`,
        relativePath: entry.sourceDocument.path,
        fieldPath: entry.sourceDocument.fieldPath,
        sources: [{
          label: "원본 YAML",
          relativePath: entry.sourceDocument.path,
          fieldPath: entry.sourceDocument.fieldPath,
          revision: `revision-${revision}`,
          currentValue,
          currentValueHash: `hash-${revision}-${currentValue}`,
          editable: true,
        }],
      };
    };
    (window as unknown as { __editorCalls: typeof calls }).__editorCalls = calls;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        if (command === "default_project_root") return "/mock/love-office";
        if (command === "load_project") return { root: "/mock/love-office", runtime, documents, issues: [] };
        if (command === "get_story_text_owner") return owner(String(args.localizationKey));
        if (command === "save_story_text") {
          const edits = args.edits as Array<{ localization_key: string; next_value?: string }>;
          const changes = edits.map((edit) => {
            const entry = runtime.localization.entries[edit.localization_key];
            const beforeValue = entry.source;
            entry.source = edit.next_value || "";
            runtime.localization.source_strings[edit.localization_key] = entry.source;
            return {
              localizationKey: edit.localization_key,
              relativePath: entry.sourceDocument.path,
              fieldPath: entry.sourceDocument.fieldPath,
              beforeValue,
              beforeExists: true,
              afterValue: entry.source,
              afterExists: true,
              sourceEdit: true,
            };
          });
          await new Promise((resolve) => window.setTimeout(resolve, 3_000));
          revision += 1;
          runtime = structuredClone(runtime);
          return {
            saved: true,
            issues: [],
            runtime,
            documents,
            changes,
            owners: edits.map((edit) => owner(edit.localization_key)),
          };
        }
        return undefined;
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,
    };
  }, { runtimeSource: runtimeFixture });

  await page.goto("/#/editor");

  await expect(page.locator(".system-dialogue-navigation")).toContainText("전체 문구34");
  await expect(page.getByRole("button", { name: /밤 활동\s*28/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /심리학 강사\s*6/ })).toBeVisible();
  await expect(page.locator(".timeline-shell, .presentation-shell, .settings-shell")).toHaveCount(0);
  await expect(page.locator(".system-dialogue-editor")).toHaveScreenshot("system-dialogue-editor.webp");

  await page.getByRole("button", { name: /활동 결과\s*6/ }).click();
  await expect(page.locator(".system-dialogue-item")).toHaveCount(6);
  await page.getByLabel("대사 내용 검색").fill("벌써 세 편");
  await expect(page.locator(".system-dialogue-item")).toHaveCount(1);
  await expect(page.locator(".system-dialogue-item h4")).toHaveText("OTT 시청");

  const fields = page.locator(".system-dialogue-item textarea");
  const saveState = page.locator(".system-dialogue-save-state");
  await fields.nth(0).fill("첫 번째 안전 저장 문구");
  await page.getByRole("button", { name: /지금 저장 \(1\)/ }).click();
  await expect(saveState).toContainText("저장하는 중");
  const continuousInput = "가".repeat(200);
  await fields.nth(1).fill(continuousInput);
  await expect(fields.nth(1)).toBeEditable();
  await expect(fields.nth(1)).toHaveValue(continuousInput);
  await expect(saveState).toContainText("2개 변경됨");

  await expect(saveState).toContainText("저장 완료", { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "↶ 마지막 저장 취소" })).toBeEnabled();
  await page.getByRole("button", { name: "↶ 마지막 저장 취소" }).click();
  await expect(saveState).toContainText("저장 완료");

  const saves = await page.evaluate(() => (window as unknown as {
    __editorCalls: Array<{ command: string }>;
  }).__editorCalls.filter((call) => call.command === "save_story_text").length);
  expect(saves).toBe(3);

  await page.getByRole("button", { name: "장면·대사" }).click();
  const storyFlow = page.getByRole("navigation", { name: "스토리 탐색기" });
  const storyFlowToggle = page.getByRole("button", { name: "Story Flow 접기" });
  await expect(storyFlowToggle).toHaveAttribute("aria-expanded", "true");
  await storyFlowToggle.click();
  await expect(storyFlow).toHaveClass(/collapsed/);
  await expect(page.locator("#story-flow-content")).toBeHidden();
  await expect(page.evaluate(() => localStorage.getItem("love-office:story-flow-collapsed"))).resolves.toBe("true");
  await page.getByRole("button", { name: "Story Flow 펼치기" }).click();
  await expect(storyFlow).not.toHaveClass(/collapsed/);
  await expect(page.locator("#story-flow-content")).toBeVisible();

  await page.getByRole("button", { name: /잘못 열린 발표 파일/ }).click();
  await page.getByPlaceholder("화면에 표시되는 문장으로 검색…").fill("요즘 운동을 다시 시작했습니다");
  await page.locator(".node-pill").first().click();

  const activityVariants = page.getByRole("navigation", { name: "직전 밤 활동별 대사" });
  await expect(activityVariants.getByRole("button")).toHaveCount(7);
  await expect(page.locator(".dialogue-variant-card")).toHaveCount(1);
  await activityVariants.getByRole("button", { name: "OTT 시청", exact: true }).click();
  await expect(page.locator(".dialogue-variant-card .layer-editor.perceived textarea")).toHaveValue(/회사 코미디/);
  await expect(page.locator(".dialogue-variant-card")).toContainText("OTT 시청을 선택한 다음 날 표시됩니다");
  await expect(page.locator(".dialogue-variant-editor")).toHaveScreenshot("self-development-variant-editor.webp");

  const filteredSource = page.locator(".node-pill").first();
  const copiedPreview = await filteredSource.locator("span").innerText();
  await filteredSource.dispatchEvent("contextmenu", { clientX: 420, clientY: 360 });
  const dialogueMenu = page.getByRole("menu", { name: "대사 편집 메뉴" });
  await expect(dialogueMenu).toBeVisible();
  await dialogueMenu.getByRole("menuitem", { name: /복사/ }).click();

  await page.getByPlaceholder("화면에 표시되는 문장으로 검색…").fill("");
  const nodeRows = page.locator(".node-pill");
  const initialNodeCount = await nodeRows.count();
  await nodeRows.nth(1).dispatchEvent("contextmenu", { clientX: 420, clientY: 420 });
  await dialogueMenu.getByRole("menuitem", { name: /다음에 붙여넣기/ }).click();
  await expect(nodeRows).toHaveCount(initialNodeCount + 1);
  await expect(page.locator(".node-pill.active span")).toHaveText(copiedPreview);

  await page.keyboard.press("Control+C");
  await nodeRows.first().click();
  await page.keyboard.press("Control+V");
  await expect(nodeRows).toHaveCount(initialNodeCount + 2);
  await expect(page.locator(".node-pill.active span")).toHaveText(copiedPreview);

  await nodeRows.first().click();
  await page.getByRole("button", { name: "현재 대사 다음에 추가" }).click();
  await expect(nodeRows).toHaveCount(initialNodeCount + 3);
  const originalLine = page.getByRole("textbox", { name: "원문 대사" });
  const innerLine = page.getByRole("textbox", { name: "속마음 대사" });
  const lineLock = page.getByRole("button", { name: "속마음 대사 잠금 풀기" });
  await expect(lineLock).toBeVisible();
  await originalLine.fill("새 대사는 처음에 함께 바뀝니다.");
  await expect(innerLine).toBeDisabled();
  await expect(innerLine).toHaveValue("새 대사는 처음에 함께 바뀝니다.");
  await lineLock.click();
  await expect(innerLine).toBeEnabled();
  await innerLine.fill("잠금을 풀면 다르게 입력됩니다.");
  await expect(originalLine).toHaveValue("새 대사는 처음에 함께 바뀝니다.");

  await page.locator(".node-pill.active").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.keyboard.press("Delete");
  await expect(nodeRows).toHaveCount(initialNodeCount + 2);

  await nodeRows.nth(1).dispatchEvent("contextmenu", { clientX: 420, clientY: 420 });
  page.once("dialog", (dialog) => dialog.accept());
  await dialogueMenu.getByRole("menuitem", { name: /^삭제/ }).click();
  await expect(nodeRows).toHaveCount(initialNodeCount + 1);
});
