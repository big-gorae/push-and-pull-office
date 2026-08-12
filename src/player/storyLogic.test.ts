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
      expect(contract.writes).toContain(`visible.heroines.${heroine}.initiative`);
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
        kind: "dual_dialogue",
        speaker: "han_do_yoon",
        variants: [{
          id: "after_workout",
          self_development: { expression: "feedback.last_workout" },
          perceived: { line: "운동을 다시 시작했습니다." },
          reality: { line: "운동을 다시 시작했습니다." },
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

  it("renders characters only from explicit stage cues", () => {
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
    expect(spoken.characters).toEqual([]);

    const twoPersonScene = runtime.scenes["common.day_01_officetel_seo_a_reveal"];
    const conversation = resolver.resolveStage(twoPersonScene, "preview", "perceived", {
      id: "preview",
      kind: "dual_dialogue",
      speaker: "yoon_seo_a",
      perceived: { line: "안녕하세요", atmosphere: "procedural", expression: "subjective_shy" },
      reality: { line: "안녕하세요", atmosphere: "procedural", intent: "courtesy" },
      next: "done",
    });
    expect(conversation.characters).toEqual([]);

    const narrated = resolver.resolveStage(scene, "preview", "perceived", {
      id: "preview",
      kind: "dual_narration",
      perceived: { line: "회의가 시작됐다.", atmosphere: "procedural" },
      reality: { line: "회의가 시작됐다.", atmosphere: "procedural", intent: "work_only" },
      next: "done",
    });
    expect(narrated.characters).toEqual([]);
  });

  it("stores a selected non-protagonist speaker as an explicit centered default", () => {
    const fresh = makeNode("dual_dialogue", "new_dialogue", "yoon_seo_a");
    expect(fresh.speaker).toBe("");
    expect(fresh.stage).toBeUndefined();

    const selected = applyDialogueSpeakerSelection(runtime, fresh, "yoon_seo_a");
    expect(selected.speaker).toBe("yoon_seo_a");
    expect(selected.stage).toEqual({
      perceived: [{
        position: "center",
        character: "yoon_seo_a",
        visual_id: "character.yoon_seo_a",
        artwork: "default",
      }],
      reality: [{
        position: "center",
        character: "yoon_seo_a",
        visual_id: "character.yoon_seo_a",
        artwork: "default",
      }],
    });

    const protagonist = applyDialogueSpeakerSelection(runtime, fresh, "han_do_yoon");
    expect(protagonist.speaker).toBe("han_do_yoon");
    expect(protagonist.stage).toBeUndefined();

    const changed = applyDialogueSpeakerSelection(runtime, selected, "cha_min_kyung");
    expect(changed.stage?.perceived?.[0]).toMatchObject({
      position: "center",
      character: "cha_min_kyung",
      visual_id: "character.cha_min_kyung",
    });

    const custom = {
      ...selected,
      stage: {
        perceived: [{ ...selected.stage!.perceived![0], position: "left" as const }],
        reality: [{ ...selected.stage!.reality![0], position: "right" as const }],
      },
    };
    const customSpeakerChanged = applyDialogueSpeakerSelection(runtime, custom, "cha_min_kyung");
    expect(customSpeakerChanged.speaker).toBe("cha_min_kyung");
    expect(customSpeakerChanged.stage).toEqual(custom.stage);
  });

  it("keeps Han Do-yoon off ordinary stages and reveals him only on an explicit ending beat", () => {
    const resolver = new VisualResolver(runtime);
    const ordinaryScene = runtime.scenes["common.day_01_officetel_seo_a_reveal"];
    const ordinaryNode: StoryNode = {
      id: "forbidden_protagonist_art",
      kind: "dual_narration",
      perceived: { line: "복도에 두 사람이 섰다.", atmosphere: "procedural" },
      reality: { line: "복도에 두 사람이 섰다.", atmosphere: "procedural", intent: "documentation" },
      stage: {
        perceived: [{
          position: "center",
          character: "han_do_yoon",
          visual_id: "character.han_do_yoon",
          artwork: "default",
        }],
      },
      next: "done",
    };
    expect(resolver.resolveStage(ordinaryScene, ordinaryNode.id, "perceived", ordinaryNode).characters).toEqual([]);

    const revealScene = runtime.scenes["ending.seo_a.report"];
    const reveal = resolver.resolveStage(revealScene, "mugshot", "perceived");
    expect(reveal.characters.map((character) => [character.character, character.position])).toEqual([
      ["han_do_yoon", "center"],
    ]);
  });

  it("supports artwork off and three explicitly positioned speaker-independent characters", () => {
    const scene = runtime.scenes["common.day_01_company_meeting"];
    const resolver = new VisualResolver(runtime);
    const visualId = (character: string) => Object.values(runtime.visuals).find((visual) =>
      visual.kind === "character" && !visual.abstract && visual.character === character)!.id;
    const choice: StoryNode = {
      id: "manual_stage",
      kind: "choice",
      prompt: "어떻게 답할까?",
      stimulus: "세 사람이 답을 기다린다.",
      stage: {
        perceived: [
          { position: "left", character: "yoon_seo_a", visual_id: visualId("yoon_seo_a"), artwork: "default" },
          { position: "center", character: "cha_min_kyung", visual_id: visualId("cha_min_kyung"), artwork: "default" },
          { position: "right", character: "kang_yoo_jin", visual_id: visualId("kang_yoo_jin"), artwork: "default" },
        ],
        reality: [],
      },
      options: [],
    };
    const perceived = resolver.resolveStage(scene, choice.id, "perceived", choice);
    expect(perceived.characters.map((character) => [character.position, character.character, character.speaker])).toEqual([
      ["left", "yoon_seo_a", false],
      ["center", "cha_min_kyung", false],
      ["right", "kang_yoo_jin", false],
    ]);
    expect(resolver.resolveStage(scene, choice.id, "reality", choice).characters).toEqual([]);
  });

  it("uses a scene default background before automatic location and atmosphere matching", () => {
    const scene = structuredClone(runtime.scenes["seo_a.email_request"]);
    scene.default_background = { visual_id: "background.empty_office", variant_id: "night" };
    const stage = new VisualResolver(runtime).resolveStage(scene, "request", "perceived");
    expect(stage.background).toMatchObject({
      visual_id: "background.empty_office",
      variant_id: "night",
      matched: ["scene-default"],
    });
  });

  it("creates an explicit zero-character silent node", () => {
    expect(makeNode("silent", "silent_view", "yoon_seo_a")).toMatchObject({
      id: "silent_view",
      kind: "silent",
      perceived: { line: "" },
      reality: { line: "" },
      stage: { perceived: [], reality: [] },
    });
  });

  it("lists and resolves every registered artwork by its stable id", () => {
    const copy = structuredClone(runtime);
    const visual = copy.visuals["character.yoon_seo_a"];
    visual.default_artwork = "office_default";
    visual.artworks = {
      office_default: { asset: "assets/characters/yoon-seo-a/office-default/base-cutout.png", label: "오피스 기본" },
      cardigan_smile: { asset: "assets/concept-art/yoon-seo-a.png", label: "가디건 미소" },
    };
    const options = characterArtworkOptions(copy, "yoon_seo_a", "perceived");
    expect(options.map((option) => option.id)).toEqual(["office_default", "cardigan_smile"]);

    const scene = copy.scenes["common.day_01_company_meeting"];
    const node: StoryNode = {
      id: "alternate_artwork",
      kind: "choice",
      prompt: "선택",
      stimulus: "서아가 기다린다.",
      stage: { perceived: [{
        position: "right",
        character: "yoon_seo_a",
        visual_id: visual.id,
        artwork: "cardigan_smile",
      }] },
      options: [],
    };
    expect(new VisualResolver(copy).resolveStage(scene, node.id, "perceived", node).characters[0]).toMatchObject({
      artwork: "cardigan_smile",
      asset: "assets/concept-art/yoon-seo-a.png",
      position: "right",
    });
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
