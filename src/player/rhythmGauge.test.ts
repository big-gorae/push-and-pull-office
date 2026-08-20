import { describe, expect, it } from "vitest";
import type { PushPullResult } from "../pushPull";
import { rhythmGaugeMotion, rhythmMarkerPercent } from "./rhythmGauge";

function feedback(overrides: Partial<PushPullResult> = {}): PushPullResult {
  return {
    kind: "score",
    action: "approach",
    previousPosition: -20,
    position: 12,
    previousAffection: 7,
    affection: 19,
    combo: 2,
    baseGain: 12,
    bonusGain: 0,
    attemptedGain: 12,
    gain: 12,
    affectionCap: 100,
    capped: false,
    target: "pull",
    reachedCheckpoint: false,
    insideOptimalRange: true,
    heroineChanged: false,
    hiddenDelta: { suspicion: 0, dislike: 0, evidence_count: 0 },
    ...overrides,
  };
}

describe("rhythm gauge presentation", () => {
  it("maps the full push-pull range to the visible track", () => {
    expect(rhythmMarkerPercent(-100)).toBe(0);
    expect(rhythmMarkerPercent(0)).toBe(50);
    expect(rhythmMarkerPercent(100)).toBe(100);
    expect(rhythmMarkerPercent(-130)).toBe(0);
    expect(rhythmMarkerPercent(140)).toBe(100);
  });

  it("keeps the old point, trail, destination, and score count-up together", () => {
    expect(rhythmGaugeMotion(feedback())).toEqual({
      from: 40,
      to: 56,
      trailLeft: 40,
      trailWidth: 16,
      scoreFrom: 7,
      scoreTo: 19,
      gain: 12,
    });
  });

  it("does not invent movement when the position did not change", () => {
    expect(rhythmGaugeMotion(feedback({ previousPosition: 12 }))).toBeUndefined();
    expect(rhythmGaugeMotion(undefined)).toBeUndefined();
  });
});
