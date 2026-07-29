import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import { buildLocalizationRows } from "../LocalizationTable";
import type { Runtime } from "../types";

const runtime = runtimeJson as unknown as Runtime;

describe("localization registry table", () => {
  it("exposes every registry entry with searchable source context", () => {
    const rows = buildLocalizationRows(runtime, "en");
    const registered = rows.filter((row) => row.entry);
    expect(registered).toHaveLength(Object.keys(runtime.localization.entries || {}).length);
    expect(new Set(registered.map((row) => row.key)).size).toBe(registered.length);
    expect(registered.every((row) => row.entry?.sourceDocument.path)).toBe(true);
    expect(registered.some((row) => row.entry?.context.sceneId && row.entry.context.nodeId)).toBe(true);
    expect(registered.some((row) => row.entry?.context.optionId)).toBe(true);
    expect(registered.some((row) => row.entry?.context.eventId)).toBe(true);
  });

  it("distinguishes direct translations from fallbacks", () => {
    const rows = buildLocalizationRows(runtime, "en");
    expect(rows.find((row) => row.key === "app.title")?.status).toBe("direct");
    expect(rows.some((row) => row.status === "fallback")).toBe(true);
  });
});
