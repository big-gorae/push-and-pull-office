import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/condition-conformance.json";
import runtimeJson from "../../build/story-runtime.json";
import { VisualResolver } from "../presentation";
import type { Condition, Runtime, StoryNode } from "../types";
import {
  canEnterScene,
  chooseSceneTransition,
  conditionMatches,
  effectiveSpeaker,
  inspectTimelineEvent,
  resolveDialogueNode,
  setPath,
} from "../storyLogic";

const runtime = runtimeJson as unknown as Runtime;

describe("condition conformance", () => {
  it.each(fixture.cases)("$id", ({ state, condition, expected }) => {
    expect(conditionMatches(state as never, condition as Condition)).toBe(expected);
  });

  it.each(fixture.entry_cases)("uses the shared entry fixture for scenes, transitions, and events: $id", (entryCase) => {
    const copy = structuredClone(runtime);
    const [target, fallback] = Object.values(copy.scenes);
    target.entry_conditions = [entryCase.condition as Condition];
    fallback.entry_conditions = [];
    const state = structuredClone(copy.initial_state);
    setPath(state, entryCase.state_patch.path, entryCase.state_patch.value);
    expect(canEnterScene(copy, state, target.id).allowed).toBe(entryCase.expected_allowed);
    const transition = chooseSceneTransition(copy, state, [
      { conditions: [], scene: target.id },
      { default: true, scene: fallback.id },
    ]);
    expect(transition.chosen?.scene).toBe(entryCase.expected_transition === "target" ? target.id : fallback.id);
    const event = structuredClone(Object.values(copy.events)[0]);
    event.scene = target.id;
    event.window = { days: [1, 3], deadline_day: 3, slots: ["morning"] };
    event.requires = { events: [], conditions: [] };
    state.progress.events.seen = [];
    state.progress.events.missed = [];
    state.progress.events.expired = [];
    const verdict = inspectTimelineEvent(copy, event, state, entryCase.state_patch.value, "morning");
    expect(verdict.eligible).toBe(entryCase.expected_event_eligible);
    if (!entryCase.expected_event_eligible) {
      expect(verdict.reasons.some((reason) => reason.includes("장면 진입 조건"))).toBe(true);
    }
  });
});

describe("contextual dialogue", () => {
  it("resolves layer-specific inner-voice speakers and explicit narration", () => {
    const node: StoryNode = {
      id: "inner",
      kind: "dual_dialogue",
      speakers: { perceived: "han_do_yoon", reality: "yoon_seo_a" },
      perceived: { line: "(내 생각)" },
      reality: { line: "(서아의 생각)" },
      next: "done",
    };
    expect(effectiveSpeaker(node, "perceived")).toBe("han_do_yoon");
    expect(effectiveSpeaker(node, "reality")).toBe("yoon_seo_a");
    expect(effectiveSpeaker({ ...node, speakers: { ...node.speakers, reality: null } }, "reality")).toBeUndefined();
  });

  it("resolves stage art for the active illustrated speaker only", () => {
    const scene = runtime.scenes["common.day_01_company_meeting"];
    const resolver = new VisualResolver(runtime);
    const spoken = resolver.resolveStage(scene, "preview", "perceived", {
      id: "preview",
      kind: "dual_dialogue",
      speaker: "yoon_seo_a",
      perceived: { line: "안녕하세요", atmosphere: "procedural", expression: "subjective_shy" },
      reality: { line: "안녕하세요", atmosphere: "procedural", intent: "work_only" },
      next: "done",
    });
    expect(spoken.characters.map((character) => character.character)).toEqual(["yoon_seo_a"]);
    expect(spoken.characters[0]?.speaker).toBe(true);

    const narrated = resolver.resolveStage(scene, "preview", "perceived", {
      id: "preview",
      kind: "dual_narration",
      perceived: { line: "회의가 시작됐다.", atmosphere: "procedural" },
      reality: { line: "회의가 시작됐다.", atmosphere: "procedural", intent: "work_only" },
      next: "done",
    });
    expect(narrated.characters).toEqual([]);
  });

  it("selects the first matching priority variant and preserves a forced backlog variant", () => {
    const node: StoryNode = {
      id: "response",
      kind: "dual_dialogue",
      speaker: "yoon_seo_a",
      variants: [
        {
          id: "guarded",
          priority: 100,
          conditions: [{ path: "derived.characters.yoon_seo_a.emotion", op: "eq", value: "fear" }],
          perceived: { line: "guarded", atmosphere: "warm_romance", expression: "subjective_shy" },
          reality: { line: "guarded", atmosphere: "cold_office", intent: "boundary" },
        },
        {
          id: "default",
          default: true,
          perceived: { line: "default", atmosphere: "warm_romance", expression: "subjective_shy" },
          reality: { line: "default", atmosphere: "cold_office", intent: "work_only" },
        },
      ],
      next: "leave",
    };
    const state = structuredClone(runtime.initial_state);
    expect(resolveDialogueNode(runtime, state, node).variantId).toBe("default");
    state.hidden.heroines.yoon_seo_a.suspicion = 70;
    expect(resolveDialogueNode(runtime, state, node).variantId).toBe("guarded");
    expect(resolveDialogueNode(runtime, state, node, "default").variantId).toBe("default");
  });

  it("uses explicit, derived, then visual reality expressions without changing perceived expression", () => {
    const copy = structuredClone(runtime);
    const state = structuredClone(copy.initial_state);
    const base: StoryNode = {
      id: "expression",
      kind: "dual_dialogue",
      speaker: "yoon_seo_a",
      perceived: { line: "p", expression: "subjective_shy" },
      reality: { line: "r" },
      next: "done",
    };
    expect(resolveDialogueNode(copy, state, base).node.reality?.expression).toBe("actual_social_smile");
    expect(resolveDialogueNode(copy, state, base).node.perceived?.expression).toBe("subjective_shy");
    state.hidden.heroines.yoon_seo_a.suspicion = 70;
    expect(resolveDialogueNode(copy, state, base).node.reality?.expression).toBe("actual_tense");
    const explicit = { ...base, reality: { ...base.reality, expression: "actual_relief" } };
    expect(resolveDialogueNode(copy, state, explicit).node.reality?.expression).toBe("actual_relief");
  });
});
