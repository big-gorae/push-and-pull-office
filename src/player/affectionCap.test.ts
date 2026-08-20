import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import { affectionCapFor, resolvePushPull } from "../pushPull";
import type { Runtime } from "../types";
import { createCampaignSession, normalizePlayerSession } from "./playerRuntime";

const runtime = runtimeJson as unknown as Runtime;

describe("decoy heroine affection cap", () => {
  it("caps Yoo-jin at 80 while combo and hidden consequences keep accumulating", () => {
    const state = structuredClone(runtime.initial_state);
    state.visible.heroines.kang_yoo_jin.affection = 78;
    const config = { action: "approach" as const, intensity: 12, base_score: 5 };

    const capped = resolvePushPull(state, "kang_yoo_jin", config, {
      affectionCap: affectionCapFor(runtime, "kang_yoo_jin"),
    });
    expect(capped).toMatchObject({
      affection: 80,
      attemptedGain: 5,
      gain: 2,
      affectionCap: 80,
      capped: true,
    });

    state.progress.flags.push_pull = {
      combo: 4,
      position: -24,
      target: "pull",
      last_action: "approach",
      heroine: "kang_yoo_jin",
    };
    const stillCapped = resolvePushPull(state, "kang_yoo_jin", config, {
      affectionCap: affectionCapFor(runtime, "kang_yoo_jin"),
    });
    expect(stillCapped.affection).toBe(80);
    expect(stillCapped.gain).toBe(0);
    expect(stillCapped.hiddenDelta).toEqual({ suspicion: 7, dislike: 4, evidence_count: 1 });
  });

  it("normalizes an older Yoo-jin score above the cap without limiting final heroines", () => {
    const legacy = createCampaignSession(runtime, "base");
    legacy.state.visible.heroines.kang_yoo_jin.affection = 99;
    legacy.state.visible.heroines.yoon_seo_a.affection = 99;

    const normalized = normalizePlayerSession(legacy, runtime);

    expect(normalized.state.visible.heroines.kang_yoo_jin.affection).toBe(80);
    expect(normalized.state.visible.heroines.yoon_seo_a.affection).toBe(99);
  });
});
