import {
  selfDevelopmentSystem,
  type SelfDevelopmentActivityOption,
  type SelfDevelopmentService,
} from "../selfDevelopment";
import type {
  Runtime,
  RuntimeState,
  SelfDevelopmentResult,
  SelfDevelopmentState,
} from "../types";

export type NightPhaseSelection = {
  status: "selecting";
  day: number;
  profile: SelfDevelopmentState;
  options: SelfDevelopmentActivityOption[];
};

export type NightPhaseActivityResult = {
  status: "result";
  day: number;
  profile: SelfDevelopmentState;
  result: SelfDevelopmentResult;
};

export type NightPhaseFinished = {
  status: "finished";
  day: number;
  profile: SelfDevelopmentState;
  activityId: string;
};

export type NightPhaseState = NightPhaseSelection | NightPhaseActivityResult | NightPhaseFinished;

export class NightPhaseError extends Error {
  constructor(
    public readonly code: "not_available" | "activity_not_completed",
    message: string,
  ) {
    super(message);
    this.name = "NightPhaseError";
  }
}

/** Coordinates the nightly lifecycle while delegating all domain rules to the service. */
export class NightPhaseCoordinator {
  constructor(private readonly selfDevelopment: SelfDevelopmentService) {}

  shouldStart(state: RuntimeState): boolean {
    this.selfDevelopment.hydrate(state);
    const day = state.progress.time.day;
    if (state.progress.time.slot !== "after_work") return false;
    if (!Number.isInteger(day) || day < 1 || day > this.selfDevelopment.maxNightDay) return false;
    if (state.progress.self_development.completed_days.includes(day)) return false;
    return this.selfDevelopment.activityOptions(state).some((option) => option.available);
  }

  start(state: RuntimeState): NightPhaseSelection {
    if (!this.shouldStart(state)) {
      throw new NightPhaseError("not_available", "The night phase is unavailable in the current state.");
    }
    return {
      status: "selecting",
      day: state.progress.time.day,
      profile: this.selfDevelopment.profile(state).snapshot(),
      options: this.selfDevelopment.activityOptions(state),
    };
  }

  choose(state: RuntimeState, activityId: string): NightPhaseActivityResult {
    if (!this.shouldStart(state)) {
      throw new NightPhaseError("not_available", "The night phase is unavailable in the current state.");
    }
    const day = state.progress.time.day;
    const result = this.selfDevelopment.performActivity(state, activityId, day);
    return {
      status: "result",
      day,
      profile: result.after,
      result,
    };
  }

  finish(state: RuntimeState): NightPhaseFinished {
    this.selfDevelopment.hydrate(state);
    const day = state.progress.time.day;
    if (!state.progress.self_development.completed_days.includes(day)) {
      throw new NightPhaseError(
        "activity_not_completed",
        `A night activity has not been completed for day ${day}.`,
      );
    }
    return {
      status: "finished",
      day,
      profile: this.selfDevelopment.profile(state).snapshot(),
      activityId: state.progress.self_development.last_activity,
    };
  }
}

const COORDINATORS = new WeakMap<Runtime, NightPhaseCoordinator>();

export function nightPhaseCoordinator(runtime: Runtime): NightPhaseCoordinator {
  const existing = COORDINATORS.get(runtime);
  if (existing) return existing;
  const created = new NightPhaseCoordinator(selfDevelopmentSystem(runtime));
  COORDINATORS.set(runtime, created);
  return created;
}
