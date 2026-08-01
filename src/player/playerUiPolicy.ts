import type { ChoiceOption, ResolvedCharacterVisual } from "../types";
import type { TimelineLogEntry } from "./playerRuntime";
import type { PlayerProfile } from "./playerStorage";

export function modeUnlocked(profile: PlayerProfile, mode: "truth_view" | "survivor_view"): boolean {
  return profile.unlockedModes.includes(mode) || profile.clearedRoutes.length > 0;
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
