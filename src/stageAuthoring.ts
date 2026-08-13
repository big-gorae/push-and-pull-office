import { PROTAGONIST_ARTWORK_CHARACTER_ID } from "./protagonistArtworkPolicy";
import type { Runtime, StageCharacterCue, StoryNode } from "./types";

function defaultCue(runtime: Runtime, characterId: string): StageCharacterCue | undefined {
  if (!characterId || characterId === PROTAGONIST_ARTWORK_CHARACTER_ID) return undefined;
  const visual = Object.values(runtime.visuals).find((candidate) =>
    candidate.kind === "character" && !candidate.abstract && candidate.character === characterId);
  if (!visual) return undefined;
  return {
    position: "center",
    character: characterId,
    visual_id: visual.id,
    artwork: "default",
  };
}

function isDefaultCenteredSpeakerStage(node: StoryNode, speakerId: string | undefined): boolean {
  if (!node.stage || !speakerId) return false;
  return node.stage.length === 1
    && node.stage[0].position === "center"
    && node.stage[0].character === speakerId
    && node.stage[0].artwork === "default";
}

/** Applies the editor's explicit one-speaker default without overwriting a custom composition. */
export function applyDialogueSpeakerSelection(runtime: Runtime, node: StoryNode, speakerId: string): StoryNode {
  const replaceDefault = !node.stage || isDefaultCenteredSpeakerStage(node, node.speaker);
  const next = { ...node, speaker: speakerId };
  if (!replaceDefault) return next;
  const cue = defaultCue(runtime, speakerId);
  if (cue) return {
    ...next,
    stage: [{ ...cue }],
  };
  const { stage: _stage, ...withoutStage } = next;
  return withoutStage;
}
