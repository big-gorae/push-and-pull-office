import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/condition-conformance.json";
import runtimeJson from "../../build/story-runtime.json";
import { characterArtworkOptions, VisualResolver } from "../presentation";
import type { Condition, Runtime, StoryNode } from "../types";
import { applyDialogueSpeakerSelection } from "../stageAuthoring";
import {
  canEnterScene,
  chooseSceneTransition,
  conditionMatches,
  deriveStateContract,
  effectiveSpeaker,
  inspectTimelineEvent,
  makeNode,
  resolveDialogueNode,
  setPath,
} from "../storyLogic";

const runtime = runtimeJson as unknown as Runtime;

describe("condition conformance", () => {
  it("classifies newly authored choice nodes as interaction not applicable", () => {
    expect(makeNode("choice", "new_choice", "yoon_seo_a").interaction_context).toEqual({
      kind: "not_applicable",
    });
  });

  it("derives push-pull state paths for every heroine targeted in a shared scene", () => {
    const scene = structuredClone(runtime.scenes["common.day_02_practical_meeting"]);
    const contract = deriveStateContract(scene, "yoon_seo_a", runtime);
    for (const heroine of ["yoon_seo_a", "cha_min_kyung"]) {
      expect(contract.writes).toContain(`visible.heroines.${heroine}.affection`);
      expect(contract.writes).toContain(`hidden.heroines.${heroine}.suspicion`);
      expect(contract.writes).toContain(`hidden.heroines.${heroine}.dislike`);
      expect(contract.writes).toContain(`hidden.heroines.${heroine}.evidence_count`);
    }
  });

  it("derives the last-activity progress path required by a self-development expression", () => {
    const scene = structuredClone(runtime.scenes["common.day_02_practical_meeting"]);
    scene.nodes = {
      activity_callback: {
        id: "activity_callback",
        kind: "dialogue",
        speaker: "han_do_yoon",
        variants: [{
          id: "after_workout",
          self_development: { expression: "feedback.last_workout" },
          line: "운동을 다시 시작했습니다.",
        }],
        next: "done",
      },
      done: { id: "done", kind: "exit", transitions: [{ ending: true }] },
    };

    const contract = deriveStateContract(scene, "yoon_seo_a", runtime);

    expect(contract.reads).toContain("progress.self_development.last_activity");
  });

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

  it("makes a bonus event eligible when its TRPG-style stat threshold is met", () => {
    const copy = structuredClone(runtime);
    const event = structuredClone(copy.events["seo_a.relief_smile"]);
    event.window = { days: [9, 10], deadline_day: 10, slots: ["morning"] };
    event.requires = {
      events: [],
      conditions: [{
        path: "visible.protagonist.self_development.stats.intelligence",
        op: "gte",
        value: 3,
      }],
    };
    const state = structuredClone(copy.initial_state);
    expect(inspectTimelineEvent(copy, event, state, 9, "morning").eligible).toBe(false);
    state.visible.protagonist.self_development.stats.intelligence = 3;
    expect(inspectTimelineEvent(copy, event, state, 9, "morning").eligible).toBe(true);
  });
});

describe("single-layer dialogue", () => {
  it("uses the node speaker directly", () => {
    expect(effectiveSpeaker({ id: "line", kind: "dialogue", speaker: "han_do_yoon", line: "말한다." })).toBe("han_do_yoon");
  });

  it("renders characters only from explicit stage cues", () => {
    const scene = runtime.scenes["common.day_01_company_meeting"];
    const resolver = new VisualResolver(runtime);
    const node: StoryNode = { id: "preview", kind: "dialogue", speaker: "yoon_seo_a", line: "안녕하세요" };
    expect(resolver.resolveStage(scene, node.id, node).characters).toEqual([]);
  });

  it("stores a selected non-protagonist speaker as one explicit centered cue", () => {
    const fresh = makeNode("dialogue", "new_dialogue", "yoon_seo_a");
    const selected = applyDialogueSpeakerSelection(runtime, fresh, "yoon_seo_a");
    expect(selected.stage).toEqual([{
      position: "center",
      character: "yoon_seo_a",
      visual_id: "character.yoon_seo_a",
      artwork: "default",
    }]);
    expect(applyDialogueSpeakerSelection(runtime, fresh, "han_do_yoon").stage).toBeUndefined();
  });

  it("keeps Seo Jung-woo off ordinary stages and reveals him on an explicit ending beat", () => {
    const resolver = new VisualResolver(runtime);
    const ordinaryScene = runtime.scenes["common.day_01_officetel_seo_a_reveal"];
    const ordinaryNode: StoryNode = {
      id: "forbidden_protagonist_art",
      kind: "narration",
      line: "복도에 두 사람이 섰다.",
      stage: [{ position: "center", character: "han_do_yoon", visual_id: "character.han_do_yoon", artwork: "default" }],
    };
    expect(resolver.resolveStage(ordinaryScene, ordinaryNode.id, ordinaryNode).characters).toEqual([]);
    const revealScene = runtime.scenes["ending.seo_a.report"];
    expect(resolver.resolveStage(revealScene, "mugshot").characters.map((character) => character.character)).toEqual(["han_do_yoon"]);
  });

  it("creates a zero-character silent node", () => {
    expect(makeNode("silent", "silent_view", "yoon_seo_a")).toMatchObject({ id: "silent_view", kind: "silent", line: "", stage: [] });
  });

  it("lists and resolves every registered artwork by stable id", () => {
    const copy = structuredClone(runtime);
    const visual = copy.visuals["character.yoon_seo_a"];
    visual.default_artwork = "office_default";
    visual.artworks = {
      office_default: { asset: "assets/characters/yoon-seo-a/office-default/base-cutout.png", label: "오피스 기본" },
      cardigan_smile: { asset: "assets/concept-art/yoon-seo-a.png", label: "가디건 미소" },
    };
    expect(characterArtworkOptions(copy, "yoon_seo_a").map((option) => option.id)).toEqual(["office_default", "cardigan_smile"]);
  });

  it("selects the first matching priority variant and preserves a forced variant", () => {
    const node: StoryNode = {
      id: "response",
      kind: "dialogue",
      speaker: "yoon_seo_a",
      variants: [
        { id: "guarded", priority: 100, conditions: [{ path: "derived.characters.yoon_seo_a.emotion", op: "eq", value: "fear" }], line: "guarded" },
        { id: "default", default: true, line: "default" },
      ],
      next: "leave",
    };
    const state = structuredClone(runtime.initial_state);
    expect(resolveDialogueNode(runtime, state, node).variantId).toBe("default");
    state.hidden.heroines.yoon_seo_a.suspicion = 70;
    expect(resolveDialogueNode(runtime, state, node).variantId).toBe("guarded");
    expect(resolveDialogueNode(runtime, state, node, "default").variantId).toBe("default");
  });
});
