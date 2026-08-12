import { PROTAGONIST_ARTWORK_CHARACTER_ID } from "./protagonistArtworkPolicy";
import type { Runtime, StageCharacterCue, StoryNode, ViewMode } from "./types";

const LAYERS: ViewMode[] = ["perceived", "reality"];

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
  return LAYERS.every((mode) => {
    const cues = node.stage?.[mode];
    return cues?.length === 1
      && cues[0].position === "center"
      && cues[0].character === speakerId
      && cues[0].artwork === "default";
  });
}

/** Applies the editor's explicit one-speaker default without overwriting a custom composition. */
export function applyDialogueSpeakerSelection(runtime: Runtime, node: StoryNode, speakerId: string): StoryNode {
  const replaceDefault = !node.stage || isDefaultCenteredSpeakerStage(node, node.speaker);
  const next = { ...node, speaker: speakerId };
  if (!replaceDefault) return next;
  const cue = defaultCue(runtime, speakerId);
  if (cue) return {
    ...next,
    stage: {
      perceived: [{ ...cue }],
      reality: [{ ...cue }],
    },
  };
  const { stage: _stage, ...withoutStage } = next;
  return withoutStage;
}
