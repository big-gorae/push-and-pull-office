import { describe, expect, it } from "vitest";
import runtimeFixture from "../../build/story-runtime.json";
import { applyRuntimePatch } from "../runtimePatch";
import type { Runtime } from "../types";

describe("applyRuntimePatch", () => {
  it("applies small runtime changes without mutating the current generation", () => {
    const current = structuredClone(runtimeFixture) as unknown as Runtime;
    const next = applyRuntimePatch(current, {
      baseSourceSha256: current.source_sha256,
      sourceSha256: "next",
      operations: [
        { op: "replace", path: "/source_sha256", value: "next" },
        { op: "replace", path: "/characters/yoon_seo_a/summary", value: "patched" },
      ],
    });
    expect(next.source_sha256).toBe("next");
    expect(next.characters.yoon_seo_a.summary).toBe("patched");
    expect(current.characters.yoon_seo_a.summary).not.toBe("patched");
    expect(next.scenes).toBe(current.scenes);
    expect(next.characters).not.toBe(current.characters);
    expect(next.characters.park_min_ji).toBe(current.characters.park_min_ji);
  });

  it("rejects a patch based on a stale runtime generation", () => {
    const current = structuredClone(runtimeFixture) as unknown as Runtime;
    expect(() => applyRuntimePatch(current, {
      baseSourceSha256: "stale",
      operations: [],
    })).toThrow(/RUNTIME_PATCH_CONFLICT/);
  });
});
