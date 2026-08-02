import type { ChoiceOption, GameModeId, ResolvedCharacterVisual, Runtime } from "../types";
import type { TimelineLogEntry } from "./playerRuntime";
import type { PlayerProfile } from "./playerStorage";
import { resolveModeAccess } from "./gameModes";

export function modeUnlocked(runtime: Runtime, profile: PlayerProfile, mode: GameModeId): boolean {
  return resolveModeAccess(runtime, mode, profile) !== "locked";
}

export function speakingCharacters(characters: ResolvedCharacterVisual[]): ResolvedCharacterVisual[] {
  return characters.filter((character) => character.character !== "han_do_yoon" && character.speaker);
}

export function choiceDebugEffect(option: ChoiceOption): { action: ChoiceOption["push_pull"]["action"]; intensity: number } {
  return { action: option.push_pull.action, intensity: option.push_pull.intensity };
}

export function dayChanged(currentDay: number, nextDay: number): boolean {
  return currentDay !== nextDay;
}

export function visibleTimelineLogs(
  logs: Array<TimelineLogEntry & { eventHasScene?: boolean }>,
  acknowledged: ReadonlySet<string>,
  realityMode: boolean,
): TimelineLogEntry[] {
  return logs.filter((entry) =>
    !entry.eventHasScene
      && !acknowledged.has(entry.id)
      && (realityMode || entry.availability !== "hidden"));
}
