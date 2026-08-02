import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import {
  ExpressionEligibilityPolicy,
  SelfDevelopmentError,
  SelfDevelopmentProfile,
  selfDevelopmentSystem,
} from "../selfDevelopment";
import type {
  Runtime,
  RuntimeState,
  SelfDevelopmentConfig,
  SelfDevelopmentState,
} from "../types";
import { NightPhaseError, nightPhaseCoordinator } from "./nightPhase";

const INITIAL_PROFILE: SelfDevelopmentState = {
  appeal: 30,
  stats: { health: 0, appearance: 0, humor: 0, intelligence: 0 },
  fatigue: 1,
};

const CONFIG: SelfDevelopmentConfig = {
  max_night_day: 16,
  activities: [
    {
      id: "workout",
      title_key: "workout.title",
      description_key: "workout.description",
      reflection_keys: { perceived: "workout.perceived", reality: "workout.reality" },
      appeal_delta: 3,
      fatigue_delta: 2,
      stat_deltas: { health: 2, appearance: 1 },
      fatigue_lte: 4,
    },
    {
      id: "reading",
      title_key: "reading.title",
      description_key: "reading.description",
      reflection_keys: { perceived: "reading.perceived", reality: "reading.reality" },
      appeal_delta: 1,
      fatigue_delta: 1,
      stat_deltas: { intelligence: 2 },
      fatigue_lte: 5,
    },
    {
      id: "ott",
      title_key: "ott.title",
      description_key: "ott.description",
      reflection_keys: { perceived: "ott.perceived", reality: "ott.reality" },
      appeal_delta: -1,
      fatigue_delta: -1,
      stat_deltas: { humor: 2 },
    },
    {
      id: "sleep",
      title_key: "sleep.title",
      description_key: "sleep.description",
      reflection_keys: { perceived: "sleep.perceived", reality: "sleep.reality" },
      appeal_delta: 0,
      fatigue_delta: -4,
      stat_deltas: {},
    },
    {
      id: "solo_drinking",
      title_key: "solo_drinking.title",
      description_key: "solo_drinking.description",
      reflection_keys: { perceived: "solo_drinking.perceived", reality: "solo_drinking.reality" },
      selectable: false,
      appeal_delta: -1,
      fatigue_delta: -2,
      stat_deltas: { health: -1 },
      fatigue_gte: 5,
    },
  ],
  expressions: {
    "health.workout_answer": {
      requires: { appeal_gte: 32, stat: "health", minimum: 2, fatigue_lte: 4 },
      score_bonus: 2,
    },
    "appearance.change_notice": {
      requires: { stat: "appearance", minimum: 2, fatigue_lte: 4 },
      score_bonus: 0,
    },
    "health.recent_workout_answer": {
      requires: {
        appeal_gte: 32,
        stat: "health",
        minimum: 2,
        fatigue_lte: 4,
        last_activity: "workout",
      },
      score_bonus: 3,
    },
  },
};

function testRuntime(): Runtime {
  const runtime = structuredClone(runtimeJson) as unknown as Runtime;
  runtime.self_development = structuredClone(CONFIG);
  runtime.initial_state.visible.protagonist = {
    self_development: structuredClone(INITIAL_PROFILE),
  };
  runtime.initial_state.progress.self_development = {
    completed_days: [],
    activity_history: [],
    last_activity: "",
  };
  return runtime;
}

function stateAtNight(runtime: Runtime, day = 1): RuntimeState {
  const state = structuredClone(runtime.initial_state);
  state.progress.time.day = day;
  state.progress.time.slot = "after_work";
  return state;
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected error code ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("self-development domain", () => {
  it("hydrates legacy and malformed state into an explicit clamped profile", () => {
    const runtime = testRuntime();
    const service = selfDevelopmentSystem(runtime);
    const legacy = stateAtNight(runtime);
    delete (legacy.visible as unknown as Record<string, unknown>).protagonist;
    delete (legacy.progress as unknown as Record<string, unknown>).self_development;

    service.hydrate(legacy);
    expect(legacy.visible.protagonist.self_development).toEqual(INITIAL_PROFILE);
    expect(legacy.progress.self_development).toEqual({
      completed_days: [],
      activity_history: [],
      last_activity: "",
    });

    (legacy.visible.protagonist as unknown as Record<string, unknown>).self_development = {
      appeal: 500,
      fatigue: -10,
      stats: { stamina: 3, health: -2, appearance: 9, humor: Number.NaN, intelligence: 3.8 },
    };
    const profile = service.profile(legacy);
    expect(profile.snapshot()).toEqual({
      appeal: 100,
      fatigue: 0,
      stats: { health: 0, appearance: 5, humor: 0, intelligence: 3 },
    });
  });

  it("encapsulates requirement checks and only exposes a score bonus while eligible", () => {
    const runtime = testRuntime();
    const service = selfDevelopmentSystem(runtime);
    const state = stateAtNight(runtime);
    state.visible.protagonist.self_development = {
      appeal: 32,
      stats: { health: 2, appearance: 2, humor: 0, intelligence: 0 },
      fatigue: 4,
    };

    expect(service.eligibility.isEligible(state, "health.workout_answer")).toBe(true);
    expect(service.eligibility.scoreBonus(state, "health.workout_answer")).toBe(2);
    expect(service.eligibility.isEligible(state, "appearance.change_notice")).toBe(true);
    expect(service.eligibility.scoreBonus(state, "appearance.change_notice")).toBe(0);
    expect(service.eligibility.isEligible(state, "health.recent_workout_answer")).toBe(false);
    expect(service.eligibility.scoreBonus(state, "health.recent_workout_answer")).toBe(0);
    expect(service.eligibility.isEligible(state, "missing.expression")).toBe(false);

    state.progress.self_development.last_activity = "workout";
    expect(service.eligibility.isEligible(state, "health.recent_workout_answer")).toBe(true);
    expect(service.eligibility.scoreBonus(state, "health.recent_workout_answer")).toBe(3);

    state.visible.protagonist.self_development.fatigue = 5;
    expect(service.eligibility.isEligible(state, "health.workout_answer")).toBe(false);
    expect(service.eligibility.isEligible(state, "health.recent_workout_answer")).toBe(false);
    expect(service.eligibility.scoreBonus(state, "health.workout_answer")).toBe(0);
  });

  it("keeps profile and eligibility objects independently usable", () => {
    const profile = SelfDevelopmentProfile.hydrate({
      appeal: 40,
      stats: { health: 3, appearance: 0, humor: 0, intelligence: 0 },
      fatigue: 2,
    });
    expect(profile.meets({ appeal_gte: 40, stat: "health", minimum: 3, fatigue_lte: 2 })).toBe(true);
    expect(profile.meets({
      appeal_gte: 40,
      stat: "health",
      minimum: 3,
      fatigue_lte: 2,
      last_activity: "workout",
    })).toBe(true);
    expect(profile.snapshot()).not.toBe(profile.snapshot());

    const policy = new ExpressionEligibilityPolicy(CONFIG.expressions, INITIAL_PROFILE);
    const runtime = testRuntime();
    const state = stateAtNight(runtime);
    state.visible.protagonist.self_development = profile.snapshot();
    expect(policy.scoreBonus(state, "health.workout_answer")).toBe(2);
    expect(policy.scoreBonus(state, "health.recent_workout_answer")).toBe(0);
    state.progress.self_development.last_activity = "workout";
    expect(policy.scoreBonus(state, "health.recent_workout_answer")).toBe(3);
  });

  it("reports activity availability without allowing fatigue to overflow", () => {
    const runtime = testRuntime();
    const service = selfDevelopmentSystem(runtime);
    const state = stateAtNight(runtime);
    state.visible.protagonist.self_development.fatigue = 5;

    const options = Object.fromEntries(
      service.activityOptions(state).map((option) => [option.activity.id, option]),
    );
    expect(options.workout).toMatchObject({ available: false, reason: "fatigue_limit" });
    expect(options.ott).toMatchObject({ available: true });
    expect(options.sleep).toMatchObject({ available: true });

    state.progress.time.slot = "morning";
    expect(service.activityOptions(state).every((option) =>
      !option.available && option.reason === "not_after_work")).toBe(true);
  });

  it("applies one activity atomically, clamps actual deltas and records one completion per day", () => {
    const runtime = testRuntime();
    const service = selfDevelopmentSystem(runtime);
    const state = stateAtNight(runtime);
    state.visible.protagonist.self_development = {
      appeal: 99,
      stats: { health: 4, appearance: 5, humor: 0, intelligence: 0 },
      fatigue: 4,
    };

    const result = service.performActivity(state, "workout", 1);
    expect(result).toMatchObject({
      activityId: "workout",
      appealDelta: 1,
      fatigueDelta: 2,
      statDeltas: { health: 1, appearance: 0 },
    });
    expect(result.after).toEqual({
      appeal: 100,
      stats: { health: 5, appearance: 5, humor: 0, intelligence: 0 },
      fatigue: 6,
    });
    expect(state.progress.self_development).toEqual({
      completed_days: [1],
      activity_history: ["workout"],
      last_activity: "workout",
    });

    const afterFirstActivity = structuredClone(state);
    expectErrorCode(() => service.performActivity(state, "sleep", 1), "already_completed");
    expect(state).toEqual(afterFirstActivity);
  });

  it("rejects unknown, unavailable and mismatched-day activities before mutation", () => {
    const runtime = testRuntime();
    const service = selfDevelopmentSystem(runtime);
    const state = stateAtNight(runtime, 2);
    state.visible.protagonist.self_development.fatigue = 6;
    const before = structuredClone(state);

    expectErrorCode(() => service.performActivity(state, "unknown", 2), "unknown_activity");
    expectErrorCode(() => service.performActivity(state, "workout", 2), "fatigue_limit");
    expectErrorCode(() => service.performActivity(state, "sleep", 3), "day_mismatch");
    expect(state).toEqual(before);
  });

  it("caches one service per runtime without sharing services across runtimes", () => {
    const first = testRuntime();
    const second = testRuntime();
    expect(selfDevelopmentSystem(first)).toBe(selfDevelopmentSystem(first));
    expect(selfDevelopmentSystem(first)).not.toBe(selfDevelopmentSystem(second));
  });
});

describe("night phase coordinator", () => {
  it("runs selecting, result and finished steps exactly once on an eligible night", () => {
    const runtime = testRuntime();
    const coordinator = nightPhaseCoordinator(runtime);
    const state = stateAtNight(runtime);

    expect(coordinator.shouldStart(state)).toBe(true);
    const intro = coordinator.start(state);
    expect(intro).toMatchObject({ status: "intro", day: 1 });
    const selecting = coordinator.continueIntro(state, intro);
    expect(selecting).toMatchObject({ status: "selecting", day: 1 });
    if (selecting.status !== "selecting") throw new Error("expected selectable night");
    expect(selecting.options.some((option) => option.available)).toBe(true);
    expectErrorCode(() => coordinator.finish(state), "activity_not_completed");

    const selected = coordinator.choose(state, "sleep");
    expect(selected).toMatchObject({
      status: "result",
      day: 1,
      result: { activityId: "sleep", fatigueDelta: -1 },
    });
    expect(coordinator.shouldStart(state)).toBe(false);
    expect(coordinator.finish(state)).toMatchObject({
      status: "finished",
      day: 1,
      activityId: "sleep",
    });
    expectErrorCode(() => coordinator.start(state), "not_available");
  });

  it("does not start before after-work or after the configured final night", () => {
    const runtime = testRuntime();
    const coordinator = nightPhaseCoordinator(runtime);
    const state = stateAtNight(runtime);
    state.progress.time.slot = "afternoon";
    expect(coordinator.shouldStart(state)).toBe(false);

    state.progress.time.slot = "after_work";
    state.progress.time.day = 17;
    expect(coordinator.shouldStart(state)).toBe(false);
  });

  it("forces solo drinking instead of choices when fatigue is high", () => {
    const runtime = testRuntime();
    const coordinator = nightPhaseCoordinator(runtime);
    const state = stateAtNight(runtime);
    state.visible.protagonist.self_development.fatigue = 5;

    const intro = coordinator.start(state);
    expect(intro).toMatchObject({ status: "intro", forcedActivityId: "solo_drinking" });
    const result = coordinator.continueIntro(state, intro);
    expect(result).toMatchObject({
      status: "result",
      result: { activityId: "solo_drinking", fatigueDelta: -2 },
    });
    expect(state.progress.self_development.last_activity).toBe("solo_drinking");
  });

  it("caches its coordinator and exposes typed domain errors", () => {
    const runtime = testRuntime();
    expect(nightPhaseCoordinator(runtime)).toBe(nightPhaseCoordinator(runtime));
    expect(new SelfDevelopmentError("invalid_day", "invalid")).toBeInstanceOf(Error);
    expect(new NightPhaseError("not_available", "invalid")).toBeInstanceOf(Error);
  });
});
