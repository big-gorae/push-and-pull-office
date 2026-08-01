import type {
  Runtime,
  RuntimeState,
  SelfDevelopmentActivity,
  SelfDevelopmentExpression,
  SelfDevelopmentProgress,
  SelfDevelopmentRequirement,
  SelfDevelopmentResult,
  SelfDevelopmentState,
  SelfDevelopmentStat,
} from "./types";

const APPEAL_MIN = 0;
const APPEAL_MAX = 100;
const STAT_MIN = 0;
const STAT_MAX = 5;
const FATIGUE_MIN = 0;
const FATIGUE_MAX = 6;
const DEFAULT_MAX_NIGHT_DAY = 16;

const SELF_DEVELOPMENT_STATS: readonly SelfDevelopmentStat[] = [
  "stamina",
  "appearance",
  "humor",
  "taste",
];

const DEFAULT_PROFILE: SelfDevelopmentState = {
  appeal: 30,
  stats: {
    stamina: 0,
    appearance: 0,
    humor: 0,
    taste: 0,
  },
  fatigue: 1,
};

const DEFAULT_PROGRESS: SelfDevelopmentProgress = {
  completed_days: [],
  activity_history: [],
  last_activity: "",
};

type UnknownRecord = Record<string, unknown>;

export type ActivityAvailabilityReason =
  | "not_after_work"
  | "outside_night_window"
  | "already_completed"
  | "fatigue_limit"
  | "fatigue_overflow";

export type SelfDevelopmentActivityOption = {
  activity: SelfDevelopmentActivity;
  available: boolean;
  reason?: ActivityAvailabilityReason;
};

export type SelfDevelopmentErrorCode =
  | ActivityAvailabilityReason
  | "unknown_activity"
  | "invalid_day"
  | "day_mismatch"
  | "duplicate_activity";

export class SelfDevelopmentError extends Error {
  constructor(
    public readonly code: SelfDevelopmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SelfDevelopmentError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integerInRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function cloneState(value: SelfDevelopmentState): SelfDevelopmentState {
  return {
    appeal: value.appeal,
    stats: { ...value.stats },
    fatigue: value.fatigue,
  };
}

function cloneActivity(value: SelfDevelopmentActivity): SelfDevelopmentActivity {
  return {
    ...value,
    reflection_keys: { ...value.reflection_keys },
    stat_deltas: { ...value.stat_deltas },
  };
}

function rawProfile(state: RuntimeState): unknown {
  const visible = (state as unknown as UnknownRecord).visible;
  if (!isRecord(visible)) return undefined;
  const protagonist = visible.protagonist;
  return isRecord(protagonist) ? protagonist.self_development : undefined;
}

function rawProgress(state: RuntimeState): unknown {
  const progress = (state as unknown as UnknownRecord).progress;
  return isRecord(progress) ? progress.self_development : undefined;
}

function writeProfile(state: RuntimeState, profile: SelfDevelopmentState): void {
  const root = state as unknown as UnknownRecord;
  const visible = isRecord(root.visible) ? root.visible : {};
  root.visible = visible;
  const protagonist = isRecord(visible.protagonist) ? visible.protagonist : {};
  visible.protagonist = protagonist;
  protagonist.self_development = cloneState(profile);
}

function writeProgress(state: RuntimeState, progress: SelfDevelopmentProgress): void {
  const root = state as unknown as UnknownRecord;
  const stateProgress = isRecord(root.progress) ? root.progress : {};
  root.progress = stateProgress;
  stateProgress.self_development = {
    completed_days: [...progress.completed_days],
    activity_history: [...progress.activity_history],
    last_activity: progress.last_activity,
  };
}

function hydrateProgress(value: unknown, fallback = DEFAULT_PROGRESS): SelfDevelopmentProgress {
  const source = isRecord(value) ? value : {};
  const fallbackDays = fallback.completed_days;
  const fallbackHistory = fallback.activity_history;
  const days = Array.isArray(source.completed_days) ? source.completed_days : fallbackDays;
  const history = Array.isArray(source.activity_history) ? source.activity_history : fallbackHistory;
  return {
    completed_days: Array.from(new Set(days.filter(
      (day): day is number => typeof day === "number" && Number.isInteger(day) && day >= 1,
    ))).sort((left, right) => left - right),
    activity_history: history.filter((id): id is string => typeof id === "string"),
    last_activity: typeof source.last_activity === "string"
      ? source.last_activity
      : fallback.last_activity,
  };
}

/** Immutable, range-safe view of the protagonist's self-development values. */
export class SelfDevelopmentProfile {
  private constructor(private readonly value: SelfDevelopmentState) {}

  static hydrate(value: unknown, fallback: SelfDevelopmentState = DEFAULT_PROFILE): SelfDevelopmentProfile {
    const source = isRecord(value) ? value : {};
    const sourceStats = isRecord(source.stats) ? source.stats : {};
    const safeFallback = cloneState(fallback);
    const stats = Object.fromEntries(SELF_DEVELOPMENT_STATS.map((stat) => [
      stat,
      integerInRange(sourceStats[stat], safeFallback.stats[stat], STAT_MIN, STAT_MAX),
    ])) as Record<SelfDevelopmentStat, number>;
    return new SelfDevelopmentProfile({
      appeal: integerInRange(source.appeal, safeFallback.appeal, APPEAL_MIN, APPEAL_MAX),
      stats,
      fatigue: integerInRange(source.fatigue, safeFallback.fatigue, FATIGUE_MIN, FATIGUE_MAX),
    });
  }

  get appeal(): number {
    return this.value.appeal;
  }

  get fatigue(): number {
    return this.value.fatigue;
  }

  stat(stat: SelfDevelopmentStat): number {
    return this.value.stats[stat];
  }

  snapshot(): SelfDevelopmentState {
    return cloneState(this.value);
  }

  meets(requirement: SelfDevelopmentRequirement): boolean {
    const appealMinimum = requirement.appeal_gte === undefined
      ? undefined
      : finiteInteger(requirement.appeal_gte);
    if (requirement.appeal_gte !== undefined && appealMinimum === undefined) return false;
    if (appealMinimum !== undefined && this.appeal < appealMinimum) return false;

    const hasStat = requirement.stat !== undefined;
    const hasMinimum = requirement.minimum !== undefined;
    if (hasStat !== hasMinimum) return false;
    if (hasStat && hasMinimum) {
      const minimum = finiteInteger(requirement.minimum);
      if (minimum === undefined || !SELF_DEVELOPMENT_STATS.includes(requirement.stat!)) return false;
      if (this.stat(requirement.stat!) < minimum) return false;
    }

    const fatigueLimit = requirement.fatigue_lte === undefined
      ? undefined
      : finiteInteger(requirement.fatigue_lte);
    if (requirement.fatigue_lte !== undefined && fatigueLimit === undefined) return false;
    return fatigueLimit === undefined || this.fatigue <= fatigueLimit;
  }

  canPerform(activity: SelfDevelopmentActivity): ActivityAvailabilityReason | undefined {
    const fatigueLimit = activity.fatigue_lte === undefined
      ? undefined
      : finiteInteger(activity.fatigue_lte);
    if (activity.fatigue_lte !== undefined && fatigueLimit === undefined) return "fatigue_limit";
    if (fatigueLimit !== undefined && this.fatigue > fatigueLimit) return "fatigue_limit";
    const fatigueDelta = finiteInteger(activity.fatigue_delta) ?? 0;
    if (fatigueDelta > 0 && this.fatigue + fatigueDelta > FATIGUE_MAX) return "fatigue_overflow";
    return undefined;
  }

  applying(activity: SelfDevelopmentActivity): SelfDevelopmentProfile {
    const stats = { ...this.value.stats };
    SELF_DEVELOPMENT_STATS.forEach((stat) => {
      stats[stat] = integerInRange(
        stats[stat] + (finiteInteger(activity.stat_deltas[stat]) ?? 0),
        stats[stat],
        STAT_MIN,
        STAT_MAX,
      );
    });
    return new SelfDevelopmentProfile({
      appeal: integerInRange(
        this.appeal + (finiteInteger(activity.appeal_delta) ?? 0),
        this.appeal,
        APPEAL_MIN,
        APPEAL_MAX,
      ),
      stats,
      fatigue: integerInRange(
        this.fatigue + (finiteInteger(activity.fatigue_delta) ?? 0),
        this.fatigue,
        FATIGUE_MIN,
        FATIGUE_MAX,
      ),
    });
  }
}

/** Keeps expression unlock policy separate from activity mutation and push-pull scoring. */
export class ExpressionEligibilityPolicy {
  private readonly expressions: ReadonlyMap<string, SelfDevelopmentExpression>;
  private readonly fallbackProfile: SelfDevelopmentState;

  constructor(
    expressions: Record<string, SelfDevelopmentExpression>,
    fallbackProfile: SelfDevelopmentState = DEFAULT_PROFILE,
  ) {
    this.fallbackProfile = SelfDevelopmentProfile.hydrate(fallbackProfile, DEFAULT_PROFILE).snapshot();
    this.expressions = new Map(Object.entries(expressions || {}).map(([id, expression]) => [
      id,
      {
        requires: { ...expression.requires },
        score_bonus: expression.score_bonus,
      },
    ]));
  }

  isEligible(state: RuntimeState, expressionId: string): boolean {
    const expression = this.expressions.get(expressionId);
    if (!expression) return false;
    return SelfDevelopmentProfile.hydrate(rawProfile(state), this.fallbackProfile)
      .meets(expression.requires);
  }

  scoreBonus(state: RuntimeState, expressionId: string): number {
    if (!this.isEligible(state, expressionId)) return 0;
    const bonus = finiteInteger(this.expressions.get(expressionId)?.score_bonus);
    return bonus === undefined ? 0 : Math.max(0, bonus);
  }
}

/** Application service for hydration, activity queries and atomic nightly updates. */
export class SelfDevelopmentService {
  readonly eligibility: ExpressionEligibilityPolicy;
  readonly maxNightDay: number;

  private readonly activities: ReadonlyMap<string, SelfDevelopmentActivity>;
  private readonly initialProfile: SelfDevelopmentState;
  private readonly initialProgress: SelfDevelopmentProgress;

  constructor(runtime: Runtime) {
    const runtimeRecord = runtime as unknown as UnknownRecord;
    const config = isRecord(runtimeRecord.self_development)
      ? runtime.self_development
      : { max_night_day: DEFAULT_MAX_NIGHT_DAY, activities: [], expressions: {} };
    this.maxNightDay = Math.max(0, finiteInteger(config.max_night_day) ?? DEFAULT_MAX_NIGHT_DAY);
    this.initialProfile = SelfDevelopmentProfile.hydrate(
      rawProfile(runtime.initial_state),
      DEFAULT_PROFILE,
    ).snapshot();
    this.initialProgress = hydrateProgress(rawProgress(runtime.initial_state));

    const activities = new Map<string, SelfDevelopmentActivity>();
    (config.activities || []).forEach((activity) => {
      if (activities.has(activity.id)) {
        throw new SelfDevelopmentError(
          "duplicate_activity",
          `Duplicate self-development activity: ${activity.id}`,
        );
      }
      activities.set(activity.id, cloneActivity(activity));
    });
    this.activities = activities;
    this.eligibility = new ExpressionEligibilityPolicy(config.expressions || {}, this.initialProfile);
  }

  hydrate(state: RuntimeState): RuntimeState {
    const profile = SelfDevelopmentProfile.hydrate(rawProfile(state), this.initialProfile).snapshot();
    const progress = hydrateProgress(rawProgress(state), this.initialProgress);
    writeProfile(state, profile);
    writeProgress(state, progress);
    return state;
  }

  profile(state: RuntimeState): SelfDevelopmentProfile {
    this.hydrate(state);
    return SelfDevelopmentProfile.hydrate(rawProfile(state), this.initialProfile);
  }

  activityOptions(state: RuntimeState): SelfDevelopmentActivityOption[] {
    this.hydrate(state);
    const profile = this.profile(state);
    const day = state.progress.time.day;
    const progress = state.progress.self_development;
    return Array.from(this.activities.values()).map((activity) => {
      let reason: ActivityAvailabilityReason | undefined;
      if (state.progress.time.slot !== "after_work") reason = "not_after_work";
      else if (!Number.isInteger(day) || day < 1 || day > this.maxNightDay) reason = "outside_night_window";
      else if (progress.completed_days.includes(day)) reason = "already_completed";
      else reason = profile.canPerform(activity);
      return {
        activity: cloneActivity(activity),
        available: reason === undefined,
        ...(reason ? { reason } : {}),
      };
    });
  }

  performActivity(state: RuntimeState, activityId: string, day: number): SelfDevelopmentResult {
    this.hydrate(state);
    if (!Number.isInteger(day) || day < 1 || day > this.maxNightDay) {
      throw new SelfDevelopmentError("invalid_day", `Night activity is unavailable on day ${day}.`);
    }
    if (day !== state.progress.time.day) {
      throw new SelfDevelopmentError(
        "day_mismatch",
        `Night activity day ${day} does not match current day ${state.progress.time.day}.`,
      );
    }
    const activity = this.activities.get(activityId);
    if (!activity) {
      throw new SelfDevelopmentError("unknown_activity", `Unknown self-development activity: ${activityId}`);
    }
    const option = this.activityOptions(state).find((candidate) => candidate.activity.id === activityId);
    if (!option?.available) {
      const code = option?.reason || "outside_night_window";
      throw new SelfDevelopmentError(code, `Self-development activity ${activityId} is unavailable: ${code}.`);
    }

    const before = this.profile(state).snapshot();
    const after = SelfDevelopmentProfile.hydrate(before).applying(activity).snapshot();
    const statDeltas = Object.fromEntries(
      Object.keys(activity.stat_deltas).map((stat) => [
        stat,
        after.stats[stat as SelfDevelopmentStat] - before.stats[stat as SelfDevelopmentStat],
      ]),
    ) as Partial<Record<SelfDevelopmentStat, number>>;
    const result: SelfDevelopmentResult = {
      activityId,
      appealDelta: after.appeal - before.appeal,
      fatigueDelta: after.fatigue - before.fatigue,
      statDeltas,
      before,
      after,
    };

    writeProfile(state, after);
    const progress = hydrateProgress(rawProgress(state), this.initialProgress);
    progress.completed_days.push(day);
    progress.completed_days.sort((left, right) => left - right);
    progress.activity_history.push(activityId);
    progress.last_activity = activityId;
    writeProgress(state, progress);
    return result;
  }
}

const SYSTEMS = new WeakMap<Runtime, SelfDevelopmentService>();

export function selfDevelopmentSystem(runtime: Runtime): SelfDevelopmentService {
  const existing = SYSTEMS.get(runtime);
  if (existing) return existing;
  const created = new SelfDevelopmentService(runtime);
  SYSTEMS.set(runtime, created);
  return created;
}
