function unavailable(): Promise<never> {
  return Promise.reject(new Error("AUTHORING_UNAVAILABLE"));
}

export function authoringRoot(): undefined {
  return undefined;
}

export const applySceneAuthoringPatch = unavailable;
export const applyVisualAssetMigration = unavailable;
export const chooseVisualAssetFile = unavailable;
export const commitSceneInsertion = unavailable;
export const copySourceLocator = unavailable;
export const getAuthoringCapabilities = unavailable;
export const getSceneAuthoringSnapshot = unavailable;
export const getStoryTextOwner = unavailable;
export const importVisualAsset = unavailable;
export const openStorySource = unavailable;
export const planSceneInsertion = unavailable;
export const readStoryAsset = unavailable;
export const revealStorySource = unavailable;
export const saveStoryText = unavailable;

export function inverseStoryTextEdits(): never[] {
  return [];
}

export function readSourceEditor(): "system" {
  return "system";
}

export function returnToStoryEditor(): void {
  // The published player has no local editor surface.
}

export function runtimeTextValues(_runtime: unknown, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, key]));
}

export function sourceLocator(source: { relativePath?: string; fieldPath?: string }): string {
  return [source.relativePath, source.fieldPath].filter(Boolean).join(" · ");
}

export function writeSourceEditor(): void {
  // The published player never persists editor preferences.
}
