import { conditionsMatch } from "../storyLogic";
import type {
  GameModeDefinition,
  GameModeId,
  JsonValue,
  Runtime,
  RuntimeState,
} from "../types";

export type ModeProfile = {
  clearedRoutes: string[];
  unlockedModes: string[];
  memories: string[];
};

export type ModeAccess = "locked" | "ready" | "coming_soon";

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  Object.entries(patch).forEach(([key, value]) => {
    const current = result[key];
    if (
      value && typeof value === "object" && !Array.isArray(value)
      && current && typeof current === "object" && !Array.isArray(current)
    ) {
      result[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = structuredClone(value);
    }
  });
  return result as T;
}

export function campaignInitialState(runtime: Runtime, campaignId: string): RuntimeState {
  const campaign = runtime.campaigns[campaignId];
  if (!campaign) throw new Error(`unknown-campaign:${campaignId}`);
  return deepMerge(
    runtime.initial_state as unknown as Record<string, unknown>,
    (campaign.initial_state_patch || {}) as unknown as Record<string, unknown>,
  ) as unknown as RuntimeState;
}

export function profileProjection(runtime: Runtime, profile: ModeProfile): RuntimeState {
  const state = structuredClone(runtime.initial_state);
  state.progress.cleared_routes = [...profile.clearedRoutes];
  state.progress.unlocked_modes = [...profile.unlockedModes];
  state.progress.memories = [...profile.memories];
  return state;
}

export function definitionUnlocked(
  runtime: Runtime,
  modeId: GameModeId,
  profile: ModeProfile,
): boolean {
  if (profile.unlockedModes.includes(modeId)) return true;
  const definition = runtime.game_modes[modeId];
  if (!definition) return false;
  if ("always" in definition.unlock) return definition.unlock.always === true;
  const state = profileProjection(runtime, profile);
  return definition.unlock.any.some((group) => conditionsMatch(state, group.conditions));
}

export function resolveModeAccess(
  runtime: Runtime,
  modeId: GameModeId,
  profile: ModeProfile,
): ModeAccess {
  const definition = runtime.game_modes[modeId];
  if (!definition || !definitionUnlocked(runtime, modeId, profile)) return "locked";
  return definition.content_status === "coming_soon" ? "coming_soon" : "ready";
}

export function unlockedModeIds(runtime: Runtime, profile: ModeProfile): GameModeId[] {
  return (Object.keys(runtime.game_modes) as GameModeId[])
    .filter((modeId) => definitionUnlocked(runtime, modeId, profile));
}

export function modeDefinition(runtime: Runtime, modeId: GameModeId): GameModeDefinition | undefined {
  return runtime.game_modes[modeId];
}

export function progressProfile(state: RuntimeState): ModeProfile {
  return {
    clearedRoutes: state.progress.cleared_routes,
    unlockedModes: state.progress.unlocked_modes,
    memories: state.progress.memories,
  };
}

export function refreshUnlockedModes(runtime: Runtime, state: RuntimeState): void {
  state.progress.unlocked_modes = unlockedModeIds(runtime, progressProfile(state));
}

export function isGameModeId(value: JsonValue | unknown): value is GameModeId {
  return value === "base" || value === "survivor_view";
}
