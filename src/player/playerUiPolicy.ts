import type { ChoiceOption, GameModeId, NodeKind, ResolvedCharacterVisual, Runtime } from "../types";
import type { TimelineLogEntry } from "./playerRuntime";
import type { PlayerProfile } from "./playerStorage";
import { resolveModeAccess } from "./gameModes";
import { isProtagonistArtwork } from "../protagonistArtworkPolicy";

export function modeUnlocked(runtime: Runtime, profile: PlayerProfile, mode: GameModeId): boolean {
  return resolveModeAccess(runtime, mode, profile) !== "locked";
}

export function visibleStageCharacters(
  characters: ResolvedCharacterVisual[],
  allowProtagonistArtwork = false,
): ResolvedCharacterVisual[] {
  return allowProtagonistArtwork
    ? characters
    : characters.filter((character) => !isProtagonistArtwork(character.character));
}

export function stageCharacterFocusClass(character: ResolvedCharacterVisual): "speaking" | "listening" {
  return character.speaker ? "speaking" : "listening";
}

export function showSceneHud(kind: NodeKind): boolean {
  return kind !== "silent";
}

export function showDialogueChrome(kind: NodeKind): boolean {
  return kind !== "choice" && kind !== "silent";
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
