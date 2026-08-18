import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import { readPushPullState } from "../pushPull";
import type { Runtime, StoryNode } from "../types";
import {
  advanceSession,
  advanceToNextMoment,
  availableOptions,
  availableTimelineEvents,
  beginSelfDevelopmentNight,
  createSession,
  createCampaignSession,
  consumeChoiceAnalysisHint,
  currentNode,
  prepareTimeSlot,
  finishSelfDevelopmentNight,
  selectSelfDevelopmentActivity,
  selectOption,
  settleSession,
  startTimelineEvent,
  type PlayerSession,
} from "./playerRuntime";

const runtime = runtimeJson as unknown as Runtime;

function finishCurrentScene(value: PlayerSession): PlayerSession {
  let session = value;
  const scene = session.sceneId ? runtime.scenes[session.sceneId] : undefined;
  const maxSteps = scene ? Object.keys(scene.nodes).length + 1 : 1;
  for (let index = 0; index < maxSteps && session.phase === "scene"; index += 1) {
    const node = currentNode(runtime, session) as StoryNode | undefined;
    if (!node) throw new Error(`Missing node at ${session.sceneId}:${session.nodeId}`);
    if (node.kind === "choice") {
      const option = availableOptions(runtime, session)[0];
      if (!option) throw new Error(`No option at ${session.sceneId}:${session.nodeId}`);
      session = selectOption(runtime, session, option.id);
    } else {
      session = advanceSession(runtime, session);
    }
  }
  if (session.phase === "scene") throw new Error(`Scene did not finish within ${maxSteps} steps: ${session.sceneId}`);
  return session;
}

function finishNight(value: PlayerSession, activityId = "sleep"): PlayerSession {
  if (value.phase !== "self_development") return value;
  const started = value.nightPhase?.status === "intro"
    ? beginSelfDevelopmentNight(runtime, value)
    : value;
  const selected = started.nightPhase?.status === "selecting"
    ? selectSelfDevelopmentActivity(runtime, started, activityId)
    : started;
  return selected.nightPhase?.status === "result"
    ? finishSelfDevelopmentNight(runtime, selected)
    : selected;
}

function advanceMeaningfulMoment(value: PlayerSession): PlayerSession {
  return finishNight(advanceToNextMoment(runtime, value));
}

describe("web player campaign runtime", () => {
  it("keeps a silent screen presentable and advances without a backlog line", () => {
    const copy = structuredClone(runtime);
    const scene = copy.scenes["seo_a.email_request"];
    scene.nodes.silent_view = {
      id: "silent_view",
      kind: "silent",
      line: "",
      stage: [],
      next: "request",
    };
    scene.node_order.unshift("silent_view");
    scene.start_node = "silent_view";

    const session = createSession(copy, "seo_a");
    session.phase = "scene";
    session.sceneId = scene.id;
    session.nodeId = "silent_view";
    const settled = settleSession(copy, session);
    expect(currentNode(copy, settled)?.kind).toBe("silent");

    const advanced = advanceSession(copy, settled);
    expect(advanced.nodeId).toBe("request");
    expect(advanced.backlog).toEqual([]);
    expect(advanced.readNodes).toContain(`${scene.id}:silent_view`);
  });

  it("starts at day one and advances only to meaningful timeline moments", () => {
    let session = createCampaignSession(runtime, "base");
    const initialHidden = structuredClone(session.state.hidden);
    const initialVisible = structuredClone(session.state.visible);
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_01_dream_and_mother_call");
    expect(session.state.progress.time).toMatchObject({ day: 1, slot: "morning" });
    expect(session.state.progress.events.seen).toContain("anchor.day_01_dream_and_mother_call");

    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_01_officetel_first_encounter");
    expect(session.state.progress.time).toMatchObject({ day: 1, slot: "morning" });
    expect(session.state.progress.events.seen).toContain("anchor.day_01_officetel_first_encounter");

    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_01_company_meeting");
    expect(session.state.progress.time).toMatchObject({ day: 1, slot: "morning" });
    expect(session.state.progress.events.seen).toContain("anchor.day_01_company_meeting");

    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_01_parent_pressure");
    expect(session.state.progress.time).toMatchObject({ day: 1, slot: "afternoon" });
    expect(session.state.progress.events.seen).toContain("anchor.day_01_parent_pressure");
    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_01_officetel_seo_a_reveal");
    expect(session.state.progress.events.seen).toContain("anchor.day_01_officetel_seo_a_reveal");
    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    expect(session.choices).toHaveLength(0);
    expect(session.state.hidden).toEqual(initialHidden);
    expect(session.state.visible).toEqual(initialVisible);
    expect(session.state.progress.flags.story_mode).toMatchObject({ target: "none" });
    expect(readPushPullState(session.state)).toMatchObject({ combo: 0, position: 0, target: "none", heroine: "" });

    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("self_development");
    expect(session.nightPhase?.status).toBe("intro");
    session = beginSelfDevelopmentNight(runtime, session);
    expect(session.nightPhase?.status).toBe("selecting");
    session = selectSelfDevelopmentActivity(runtime, session, "workout");
    expect(session.nightPhase?.status).toBe("result");
    expect(session.state.visible.protagonist.self_development).toMatchObject({
      appeal: 33,
      fatigue: 3,
      stats: { health: 2, appearance: 1 },
    });
    session = finishSelfDevelopmentNight(runtime, session);
    expect(session.state.progress.time).toMatchObject({ day: 2, slot: "morning" });
    expect(session.state.progress.events.seen).toContain("anchor.day_02_practical_meeting");
    expect(session.phase).toBe("scene");
    expect(session.sceneId).toBe("common.day_02_practical_meeting");
    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");

    const weekOneCallbackScenes: string[] = [];
    for (let index = 0; index < 64; index += 1) {
      if (
        session.phase === "timeline"
        && session.state.progress.time.day === 7
        && session.state.progress.time.slot === "lunch"
      ) break;
      if (session.phase === "scene") {
        if (session.sceneId?.startsWith("common.day_0")) {
          weekOneCallbackScenes.push(session.sceneId);
        }
        session = finishCurrentScene(session);
      } else {
        session = advanceMeaningfulMoment(session);
      }
    }
    expect(weekOneCallbackScenes).toEqual([
      "common.day_03_business_trip_or_cafe",
      "common.day_03_officetel_min_kyung_move_in",
      "common.day_04_weekend_encounter",
      "common.day_05_weekend_reflection",
    ]);
    expect(session.state.progress.time).toMatchObject({ day: 7, slot: "lunch" });
    expect(availableTimelineEvents(runtime, session).map((event) => event.id)).toContain("seo_a.email_request");
  });

  it("returns to the timeline after a return_to_timeline event instead of chaining its route", () => {
    let session = createCampaignSession(runtime, "base");
    session = finishCurrentScene(session);
    for (let index = 0; index < 24; index += 1) {
      session = advanceMeaningfulMoment(session);
      if (session.phase === "scene") session = finishCurrentScene(session);
      if (session.state.progress.time.day === 7 && session.state.progress.time.slot === "lunch") break;
    }
    session = startTimelineEvent(runtime, session, "seo_a.email_request");
    expect(session.phase).toBe("scene");
    expect(session.version).toBe(6);

    session = finishCurrentScene(session);
    expect(session.phase).toBe("timeline");
    expect(session.currentEventId).toBeUndefined();
    expect(session.state.progress.events.seen).toContain("seo_a.email_request");
    expect(session.state.progress.events.seen).not.toContain("seo_a.relief_smile");
    const dialogue = session.backlog.find((entry) => entry.kind === "dialogue");
    expect(dialogue?.variantId).toBe("default");
    expect(dialogue).not.toHaveProperty("text");
  });

  it("selects a conditional dialogue variant during actual player advancement", () => {
    const copy = structuredClone(runtime);
    const scene = copy.scenes["seo_a.email_request"];
    const node = scene.nodes.request;
    const line = node.line || "";
    delete node.line;
    node.variants = [
      {
        id: "guarded",
        priority: 100,
        conditions: [{ path: "hidden.heroines.yoon_seo_a.suspicion", op: "gte", value: 60 }],
        line: "guarded",
      },
      { id: "default", default: true, line },
    ];
    const session = createSession(copy, "seo_a");
    session.phase = "scene";
    session.sceneId = scene.id;
    session.nodeId = node.id;
    session.state.hidden.heroines.yoon_seo_a.suspicion = 70;
    const advanced = advanceSession(copy, session);
    expect(advanced.backlog.at(-1)?.variantId).toBe("guarded");
  });

  it("unlocks a self-development interaction without changing the push-pull score", () => {
    const base = createSession(runtime, "seo_a");
    base.phase = "scene";
    base.sceneId = "seo_a.email_request";
    base.nodeId = "interpret";
    base.routeId = "seo_a";
    expect(availableOptions(runtime, base).map((option) => option.id))
      .not.toContain("mention_workout_and_step_back");

    const trained = structuredClone(base);
    trained.state.visible.protagonist.self_development.appeal = 32;
    trained.state.visible.protagonist.self_development.stats.health = 2;
    trained.state.visible.protagonist.self_development.fatigue = 3;
    expect(availableOptions(runtime, trained).map((option) => option.id))
      .toContain("mention_workout_and_step_back");

    const ordinary = selectOption(runtime, structuredClone(trained), "match_push");
    const promoted = selectOption(runtime, structuredClone(trained), "mention_workout_and_step_back");
    expect(promoted.lastFeedback).toMatchObject({
      baseGain: ordinary.lastFeedback?.baseGain,
      bonusGain: 0,
      gain: ordinary.lastFeedback?.gain,
      position: ordinary.lastFeedback?.position,
      combo: ordinary.lastFeedback?.combo,
      target: ordinary.lastFeedback?.target,
      hiddenDelta: ordinary.lastFeedback?.hiddenDelta,
    });
    expect(promoted.state.hidden).toEqual(ordinary.state.hidden);
  });

  it("applies a common-scene choice to its declared push-pull target", () => {
    const session = createSession(runtime, "seo_a");
    session.phase = "scene";
    session.sceneId = "common.day_02_practical_meeting";
    session.nodeId = "recovery_choice";
    session.routeId = "seo_a";
    const seoAAffection = session.state.visible.heroines.yoon_seo_a.affection;
    const minKyungAffection = session.state.visible.heroines.cha_min_kyung.affection;

    const selected = selectOption(runtime, session, "define_and_fix");

    expect(selected.state.visible.heroines.yoon_seo_a.affection).toBe(seoAAffection);
    expect(selected.state.visible.heroines.cha_min_kyung.affection).toBeGreaterThan(minKyungAffection);
    expect(readPushPullState(selected.state)).toMatchObject({
      heroine: "cha_min_kyung",
      combo: 1,
      position: -12,
    });
    expect(selected.state.progress.flags.story_mode).toMatchObject({
      target: "none",
      day_02_response: "factual_resolution",
    });
  });

  it("spends one charged hint at a choice and reports the active scoring direction", () => {
    const session = createSession(runtime, "seo_a");
    session.phase = "scene";
    session.sceneId = "common.day_02_practical_meeting";
    session.nodeId = "recovery_choice";
    session.state.progress.self_development.hint_charges = 1;
    session.state.progress.flags.push_pull = {
      combo: 2,
      position: -24,
      target: "pull",
      last_action: "approach",
      heroine: "yoon_seo_a",
    };

    const consumed = consumeChoiceAnalysisHint(runtime, session);
    expect(consumed?.hint).toMatchObject({
      direction: "pull",
      lesson: expect.stringContaining("서아는 사과 뒤 멈췄고"),
    });
    expect(consumed?.session.state.progress.self_development.hint_charges).toBe(0);
    expect(session.state.progress.self_development.hint_charges).toBe(1);
    expect(consumeChoiceAnalysisHint(runtime, consumed!.session)).toBeUndefined();
  });

  it.each([
    ["health", "company.stat_health_sample_sorting", "cg.stat.health.min_kyung"],
    ["intelligence", "company.stat_intelligence_version_check", "cg.stat.intelligence.min_kyung"],
    ["humor", "company.stat_humor_tasting_vote", "cg.stat.humor.seo_a"],
    ["appearance", "company.stat_appearance_rehearsal", "cg.stat.appearance.yoo_jin"],
  ] as const)("opens the week-one %s stat event and awards its artwork", (stat, eventId, memory) => {
    const session = createSession(runtime, "seo_a");
    session.phase = "timeline";
    session.state.progress.time = { day: stat === "appearance" ? 4 : 3, act: 1, slot: "afternoon" };
    session.state.progress.events.seen = ["anchor.day_03_business_trip_or_cafe"];
    session.state.visible.protagonist.self_development.stats[stat] = 3;

    expect(availableTimelineEvents(runtime, session).map((event) => event.id)).toContain(eventId);
    const entered = startTimelineEvent(runtime, session, eventId);
    expect(entered.state.progress.memories).toContain(memory);
    expect(entered.currentEventId).toBe(eventId);
  });

  it("preserves a matching combo when entering a shared scene with multiple push-pull targets", () => {
    const session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 2, act: 1, slot: "morning" };
    session.state.progress.events.seen = [
      "anchor.day_01_dream_and_mother_call",
      "anchor.day_01_officetel_first_encounter",
      "anchor.day_01_company_meeting",
      "anchor.day_01_parent_pressure",
      "anchor.day_01_officetel_seo_a_reveal",
    ];
    session.state.progress.flags.push_pull = {
      combo: 2,
      position: -24,
      target: "pull",
      last_action: "approach",
      heroine: "cha_min_kyung",
    };

    const entered = prepareTimeSlot(runtime, session);
    expect(entered.phase).toBe("scene");
    expect(entered.sceneId).toBe("common.day_02_practical_meeting");
    expect(readPushPullState(entered.state)).toMatchObject({
      heroine: "cha_min_kyung",
      combo: 2,
      position: -24,
    });

    const atChoice = { ...entered, nodeId: "recovery_choice" };
    const selected = selectOption(runtime, atChoice, "define_and_fix");
    expect(readPushPullState(selected.state)).toMatchObject({
      heroine: "cha_min_kyung",
      combo: 3,
      position: -36,
    });
  });

  it("does not make a heroine notice an overnight physical change", () => {
    const baseline = createSession(runtime, "seo_a");
    baseline.phase = "scene";
    baseline.sceneId = "seo_a.email_request";
    baseline.nodeId = "appearance_observation";
    expect(advanceSession(runtime, baseline).backlog.at(-1)?.variantId).toBe("default");

    const trained = structuredClone(baseline);
    trained.state.visible.protagonist.self_development.appeal = 32;
    trained.state.visible.protagonist.self_development.stats.health = 2;
    trained.state.visible.protagonist.self_development.fatigue = 3;
    expect(advanceSession(runtime, trained).backlog.at(-1)?.variantId).toBe("default");
  });

  it("does not mark an event seen when its scene entry condition fails", () => {
    const copy = structuredClone(runtime);
    const source = copy.events["seo_a.email_request"];
    const event = structuredClone(source);
    event.id = "test.entry.blocked";
    event.availability = "player";
    event.window = { days: [1, 1], deadline_day: 1, slots: ["morning"] };
    event.requires = { events: [], conditions: [] };
    event.on_seen = { effects: [{ path: "progress.memories", op: "append_unique", value: "should_not_apply" }] };
    copy.events[event.id] = event;
    const scene = copy.scenes[event.scene!];
    scene.entry_conditions = [{ path: "progress.time.day", op: "gte", value: 99 }];
    let session = createCampaignSession(copy, "base");
    session.phase = "timeline";
    session.preparedTimeKey = "1:morning";
    session.state.progress.time = { day: 1, act: 1, slot: "morning" };
    session = startTimelineEvent(copy, session, event.id);
    expect(session.state.progress.events.seen).not.toContain(event.id);
    expect(session.state.progress.memories).not.toContain("should_not_apply");
    expect(session.timelineLog.some((entry) => entry.eventId === event.id && entry.status === "seen")).toBe(false);
  });

  it("returns an explicit route-entry rejection with the full decision trace", () => {
    const copy = structuredClone(runtime);
    const route = Object.values(copy.routes)[0];
    const scene = copy.scenes[route.entry_scene];
    scene.entry_conditions = [{ path: "progress.time.day", op: "gte", value: 99 }];
    const session = createSession(copy, route.id);
    expect(session.phase).toBe("complete");
    expect(session.endingId).toBe(`scene-entry-rejected:${scene.id}`);
    expect(session.lastEntryDecision).toMatchObject({ sceneId: scene.id, allowed: false });
    expect(session.lastEntryDecision?.trace).toEqual([
      expect.objectContaining({ actual: 1, met: false }),
    ]);
  });

  it("expires a skipped event after its deadline and applies the missed record", () => {
    let session = createCampaignSession(runtime, "base");
    session = finishCurrentScene(session);
    for (let index = 0; index < 40; index += 1) {
      session = advanceMeaningfulMoment(session);
      if (session.phase === "scene") session = finishCurrentScene(session);
      if (session.state.progress.events.missed.includes("seo_a.email_request")) break;
    }
    expect(session.state.progress.events.missed).toContain("seo_a.email_request");
    expect(session.state.progress.events.expired).toContain("seo_a.email_request");
    expect(session.timelineLog.some((entry) => entry.eventId === "seo_a.email_request" && entry.status === "missed")).toBe(true);
  });

  it("breaks the current combo when choosing an event for another heroine", () => {
    let session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 7, act: 2, slot: "after_work" };
    session.state.progress.flags.push_pull = {
      combo: 3,
      position: -24,
      target: "push",
      last_action: "approach",
      heroine: "yoon_seo_a",
    };
    session = prepareTimeSlot(runtime, session);
    session = startTimelineEvent(runtime, session, "min_kyung.explicit_boundary");
    expect(session.phase).toBe("scene");
    expect(readPushPullState(session.state)).toMatchObject({ combo: 0, target: "none", position: -24 });
  });

  it("chooses the higher-priority ending inside an exclusive ending group", () => {
    const session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 17, act: 3, slot: "after_work" };
    session.state.progress.events.seen = ["seo_a.relief_smile", "anchor.day_17_home_surprise"];
    session.state.progress.flags.story_mode = {
      target: "yoon_seo_a",
      final_interpretation: "undecided",
      home_incident: "none",
      yoo_jin_intervention: false,
    };
    session.state.hidden.heroines.yoon_seo_a.evidence_count = 2;
    session.state.hidden.heroines.yoon_seo_a.dislike = 25;

    const ending = prepareTimeSlot(runtime, session);
    expect(ending.phase).toBe("scene");
    expect(ending.currentEventId).toBe("seo_a.ending_report");
    expect(ending.sceneId).toBe("ending.seo_a.report");
  });

  it("persists route clear and mode unlocks when an ending is reached", () => {
    const session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 17, act: 3, slot: "after_work" };
    session.state.progress.events.seen = ["seo_a.relief_smile", "anchor.day_17_home_surprise"];
    session.state.progress.flags.story_mode = {
      target: "yoon_seo_a",
      final_interpretation: "undecided",
      home_incident: "none",
      yoo_jin_intervention: false,
    };
    session.state.hidden.heroines.yoon_seo_a.evidence_count = 2;
    session.state.hidden.heroines.yoon_seo_a.dislike = 25;

    const completed = finishCurrentScene(prepareTimeSlot(runtime, session));
    expect(completed.phase).toBe("complete");
    expect(completed.state.progress.cleared_routes).toContain("seo_a");
    expect(completed.state.progress.unlocked_modes).toContain("survivor_view");
  });

  it("does not clear the decoy Min-kyung route or unlock another story", () => {
    const session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 17, act: 3, slot: "after_work" };
    session.state.progress.events.seen = ["min_kyung.witness_meeting", "anchor.day_17_home_surprise"];
    session.state.progress.flags.story_mode = {
      target: "cha_min_kyung",
      final_interpretation: "undecided",
      home_incident: "none",
      yoo_jin_intervention: false,
    };
    session.state.hidden.heroines.cha_min_kyung.evidence_count = 2;
    session.state.hidden.heroines.cha_min_kyung.dislike = 40;

    const ending = prepareTimeSlot(runtime, session);
    expect(ending.sceneId).toBe("ending.min_kyung.report");
    const completed = finishCurrentScene(ending);
    expect(completed.phase).toBe("complete");
    expect(completed.state.progress.cleared_routes).not.toContain("min_kyung");
    expect(completed.state.progress.unlocked_modes).not.toContain("survivor_view");
  });

  it("does not award a route clear when the calendar ends without a narrative ending", () => {
    let session = createCampaignSession(runtime, "base");
    session.phase = "timeline";
    session.routeId = "seo_a";
    session.preparedTimeKey = "17:after_work";
    session.state.progress.time = { day: 17, act: 3, slot: "after_work" };
    session.state.progress.events.seen = Object.keys(runtime.events);
    session = advanceToNextMoment(runtime, session);
    expect(session.phase).toBe("complete");
    expect(session.endingId).toBe("campaign.complete");
    expect(session.state.progress.cleared_routes).not.toContain("seo_a");
    expect(session.state.progress.unlocked_modes).not.toContain("survivor_view");
  });
});
