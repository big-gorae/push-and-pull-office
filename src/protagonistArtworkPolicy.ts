import type { Scene, StoryNode } from "./types";

export const PROTAGONIST_ARTWORK_CHARACTER_ID = "han_do_yoon";
export const PROTAGONIST_ARTWORK_REVEAL_FLAG = "protagonist_art_reveal";

export function isProtagonistArtwork(characterId: string | null | undefined): boolean {
  return characterId === PROTAGONIST_ARTWORK_CHARACTER_ID;
}

export function canRevealProtagonistArtwork(scene: Scene, node: StoryNode | undefined): boolean {
  return Boolean(
    node
    && scene.id.startsWith("ending.")
    && node.kind === "dual_narration"
    && node.presentation_flags?.includes(PROTAGONIST_ARTWORK_REVEAL_FLAG),
  );
}
