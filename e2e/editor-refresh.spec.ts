import { expect, test } from "@playwright/test";
import runtimeFixture from "../build/story-runtime.json" with { type: "json" };

test("editor reloads the current project from disk by button and shortcut", async ({ page }) => {
  await page.addInitScript(({ runtimeSource }) => {
    localStorage.clear();
    localStorage.setItem("love-office:last-workspace", "scene");
    const runtime = structuredClone(runtimeSource) as typeof runtimeSource;
    let loadCount = 0;
    const meta = (path: string) => ({ path, revision: "revision-1", source: "" });
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
    (window as unknown as { __loadCount: () => number }).__loadCount = () => loadCount;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        if (command === "default_project_root") return "/mock/love-office";
        if (command === "load_project") {
          loadCount += 1;
          return { root: "/mock/love-office", runtime, documents, issues: [] };
        }
        return undefined;
      },
      transformCallback: () => 1,
      unregisterCallback: () => undefined,
      convertFileSrc: (path: string) => path,
    };
  }, { runtimeSource: runtimeFixture });

  await page.goto("/#/editor");
  const loadCount = () => page.evaluate(() => (window as unknown as { __loadCount: () => number }).__loadCount());
  await expect.poll(loadCount).toBe(1);

  await page.getByRole("button", { name: "디스크에서 다시 읽기" }).click();
  await expect(page.locator(".status-line")).toContainText("프로젝트를 디스크에서 다시 읽었습니다.");
  await expect.poll(loadCount).toBe(2);

  await page.keyboard.press("Control+R");
  await expect.poll(loadCount).toBe(3);
});
