import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import { PUSH_PULL_OPTIMAL_LIMIT, pushPullPositionLabel } from "../pushPull";
import type { ChoiceOption, ResolvedCharacterVisual, Runtime } from "../types";
import type { TimelineLogEntry } from "./playerRuntime";
import {
  choiceDebugEffect,
  dayChanged,
  modeUnlocked,
  showDialogueChrome,
  showSceneHud,
  visibleStageCharacters,
  visibleTimelineLogs,
} from "./playerUiPolicy";

const runtime = runtimeJson as unknown as Runtime;

describe("player UI policy", () => {
  it("locks both extra modes until the first ending and accepts the persisted unlock", () => {
    const fresh = { clearedRoutes: [], unlockedModes: ["base"], memories: [] };
    expect(modeUnlocked(runtime, fresh, "truth_view")).toBe(false);
    expect(modeUnlocked(runtime, fresh, "survivor_view")).toBe(false);

    const cleared = { ...fresh, clearedRoutes: ["seo_a"] };
    expect(modeUnlocked(runtime, cleared, "truth_view")).toBe(true);
    expect(modeUnlocked(runtime, cleared, "survivor_view")).toBe(true);
  });

  it("renders every character explicitly resolved onto the stage", () => {
    const character = (characterId: string, speaker: boolean) => ({
      character: characterId,
      speaker,
    } as ResolvedCharacterVisual);
    const visible = visibleStageCharacters([
      character("yoon_seo_a", true),
      character("cha_min_kyung", false),
      character("han_do_yoon", true),
    ]);
    expect(visible.map((entry) => entry.character)).toEqual(["yoon_seo_a", "cha_min_kyung", "han_do_yoon"]);
  });

  it("shows a silent beat as artwork only", () => {
    expect(showSceneHud("silent")).toBe(false);
    expect(showDialogueChrome("silent")).toBe(false);
    expect(showSceneHud("dual_dialogue")).toBe(true);
    expect(showDialogueChrome("dual_dialogue")).toBe(true);
  });

  it("keeps push-pull mechanics available for debug labels without changing player copy", () => {
    const option = { push_pull: { action: "space", intensity: 16, base_score: 4 } } as ChoiceOption;
    expect(choiceDebugEffect(option)).toEqual({ action: "space", intensity: 16 });
    expect(PUSH_PULL_OPTIMAL_LIMIT).toBe(56);
    expect(pushPullPositionLabel(0, "perceived")).toBe("균형 지점");
    expect(pushPullPositionLabel(20, "perceived")).not.toContain("적정 범위");
  });

  it("shows scene-less event beats in game and hides truth-only beats in story mode", () => {
    const base = {
      day: 2,
      slot: "morning",
      status: "seen",
    } as TimelineLogEntry;
    const logs: Array<TimelineLogEntry & { eventHasScene: boolean }> = [
      { ...base, id: "seen:visible", eventId: "visible", availability: "automatic", eventHasScene: false },
      { ...base, id: "seen:hidden", eventId: "hidden", availability: "hidden", eventHasScene: false },
      { ...base, id: "seen:scene", eventId: "scene", availability: "automatic", eventHasScene: true },
    ];
    expect(visibleTimelineLogs(logs, new Set(), false).map((entry) => entry.eventId)).toEqual(["visible"]);
    expect(visibleTimelineLogs(logs, new Set(["seen:visible"]), true).map((entry) => entry.eventId)).toEqual(["hidden"]);
  });

  it("requests a cinematic transition only when the day changes", () => {
    expect(dayChanged(1, 1)).toBe(false);
    expect(dayChanged(1, 2)).toBe(true);
  });
});
