import type { JsonValue, PushPullConfig, RuntimeState } from "./types";

export const PUSH_PULL_LIMIT = 100;
export const PUSH_PULL_OPTIMAL_LIMIT = 56;
export const PUSH_PULL_CHECKPOINT = 32;
export const PUSH_PULL_TURN_BONUS = 6;
export const PUSH_PULL_MAX_COMBO = 5;

export type PushPullTarget = "pull" | "push" | "none";
export type PushPullLastAction = PushPullConfig["action"] | "none";

export type PushPullState = {
  combo: number;
  position: number;
  target: PushPullTarget;
  last_action: PushPullLastAction;
  heroine: string;
};

export type PushPullResultKind = "score" | "turn" | "wrong" | "outside" | "literal";

export type PushPullResult = {
  kind: PushPullResultKind;
  action: PushPullConfig["action"];
  previousPosition: number;
  position: number;
  previousInitiative: number;
  initiative: number;
  combo: number;
  gain: number;
  target: PushPullTarget;
  reachedCheckpoint: boolean;
  insideOptimalRange: boolean;
  heroineChanged: boolean;
  hiddenDelta: {
    suspicion: number;
    dislike: number;
    evidence_count: number;
  };
};

const DEFAULT_STATE: PushPullState = {
  combo: 0,
  position: 0,
  target: "none",
  last_action: "none",
  heroine: "",
};

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function readPushPullState(state: RuntimeState): PushPullState {
  const raw = state.progress.flags.push_pull;
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, JsonValue>
    : {};
  const target = value.target === "pull" || value.target === "push" || value.target === "none"
    ? value.target
    : DEFAULT_STATE.target;
  const lastAction = value.last_action === "approach" || value.last_action === "space"
    || value.last_action === "literal" || value.last_action === "none"
    ? value.last_action
    : DEFAULT_STATE.last_action;
  return {
    combo: numberInRange(value.combo, DEFAULT_STATE.combo, 0, PUSH_PULL_MAX_COMBO),
    position: numberInRange(value.position, DEFAULT_STATE.position, -PUSH_PULL_LIMIT, PUSH_PULL_LIMIT),
    target,
    last_action: lastAction,
    heroine: typeof value.heroine === "string" ? value.heroine : DEFAULT_STATE.heroine,
  };
}

export function writePushPullState(state: RuntimeState, value: PushPullState): void {
  state.progress.flags.push_pull = { ...value };
}

export function breakPushPullFlow(state: RuntimeState, keepPosition = true): void {
  const current = readPushPullState(state);
  writePushPullState(state, {
    ...current,
    combo: 0,
    position: keepPosition ? current.position : 0,
    target: "none",
    last_action: "none",
    heroine: "",
  });
}

function addHiddenPatternEffects(
  state: RuntimeState,
  heroine: string,
  combo: number,
  reachedCheckpoint: boolean,
): PushPullResult["hiddenDelta"] {
  const hidden = state.hidden.heroines[heroine];
  const delta = { suspicion: 0, dislike: 0, evidence_count: 0 };
  if (!hidden || combo < 3) return delta;
  if (combo === 3) delta.suspicion = 3;
  else if (combo === 4) {
    delta.suspicion = 5;
    delta.dislike = 2;
  } else {
    delta.suspicion = 7;
    delta.dislike = 4;
    if (reachedCheckpoint) delta.evidence_count = 1;
  }
  hidden.suspicion = Math.min(100, hidden.suspicion + delta.suspicion);
  hidden.dislike = Math.min(100, hidden.dislike + delta.dislike);
  hidden.evidence_count = Math.min(99, hidden.evidence_count + delta.evidence_count);
  return delta;
}

export function resolvePushPull(
  state: RuntimeState,
  heroine: string,
  config: PushPullConfig,
): PushPullResult {
  const current = readPushPullState(state);
  const heroineChanged = Boolean(current.heroine && current.heroine !== heroine);
  const previousPosition = current.position;
  const previousInitiative = state.visible.heroines[heroine]?.initiative ?? 0;
  const intensity = numberInRange(config.intensity, 12, 8, 16);
  const baseScore = numberInRange(config.base_score, 4, 2, 5);
  let combo = heroineChanged ? 0 : current.combo;
  let target: PushPullTarget = heroineChanged ? "none" : current.target;
  let position = current.position;
  let gain = 0;
  let reachedCheckpoint = false;
  let kind: PushPullResultKind;

  if (config.action === "literal") {
    position = position < 0 ? Math.min(0, position + intensity)
      : position > 0 ? Math.max(0, position - intensity) : 0;
    combo = 0;
    target = "none";
    kind = "literal";
  } else {
    const direction: Exclude<PushPullTarget, "none"> = config.action === "approach" ? "pull" : "push";
    if (target === "none") target = direction;
    const movement = direction === "pull" ? -intensity : intensity;
    position = Math.max(-PUSH_PULL_LIMIT, Math.min(PUSH_PULL_LIMIT, position + movement));
    const previousInside = Math.abs(previousPosition) <= PUSH_PULL_OPTIMAL_LIMIT;
    const inside = Math.abs(position) <= PUSH_PULL_OPTIMAL_LIMIT;
    const movingTowardTarget = target === "pull" ? position < previousPosition : position > previousPosition;
    reachedCheckpoint = target === "pull"
      ? previousPosition > -PUSH_PULL_CHECKPOINT && position <= -PUSH_PULL_CHECKPOINT
      : previousPosition < PUSH_PULL_CHECKPOINT && position >= PUSH_PULL_CHECKPOINT;

    if (previousInside && inside && movingTowardTarget) {
      combo = Math.min(PUSH_PULL_MAX_COMBO, combo + 1);
      gain = baseScore * combo;
      kind = "score";
      if (reachedCheckpoint) {
        gain += PUSH_PULL_TURN_BONUS;
        target = target === "pull" ? "push" : "pull";
        kind = "turn";
      }
      const visible = state.visible.heroines[heroine];
      if (visible) visible.initiative = Math.min(100, visible.initiative + gain);
    } else {
      combo = 0;
      kind = inside ? "wrong" : "outside";
      if (!inside) target = position < -PUSH_PULL_OPTIMAL_LIMIT ? "push" : "pull";
    }
  }

  const hiddenDelta = kind === "score" || kind === "turn"
    ? addHiddenPatternEffects(state, heroine, combo, reachedCheckpoint)
    : { suspicion: 0, dislike: 0, evidence_count: 0 };
  const next: PushPullState = {
    combo,
    position,
    target,
    last_action: config.action,
    heroine,
  };
  writePushPullState(state, next);

  return {
    kind,
    action: config.action,
    previousPosition,
    position,
    previousInitiative,
    initiative: state.visible.heroines[heroine]?.initiative ?? previousInitiative,
    combo,
    gain,
    target,
    reachedCheckpoint,
    insideOptimalRange: Math.abs(position) <= PUSH_PULL_OPTIMAL_LIMIT,
    heroineChanged,
    hiddenDelta,
  };
}

export function pushPullPositionLabel(position: number, mode: "perceived" | "reality"): string {
  const side = position < -4 ? (mode === "perceived" ? "당기기 쪽" : "접근 시도 쪽")
    : position > 4 ? (mode === "perceived" ? "밀기 쪽" : "거리 둠 쪽")
      : "균형 지점";
  return side;
}

export function pushPullTargetLabel(target: PushPullTarget, mode: "perceived" | "reality"): string {
  if (target === "pull") return mode === "perceived" ? "당기기" : "접근 시도";
  if (target === "push") return mode === "perceived" ? "밀기" : "거리 둠";
  return "첫 방향";
}
