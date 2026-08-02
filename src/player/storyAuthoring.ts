import type { Runtime, ValidationIssue } from "../types";

const AUTHORING_ROOT_KEY = "love-office:authoring-root";

export type StoryTextSource = {
  label: string;
  relativePath: string;
  fieldPath: string;
  line?: number;
  column?: number;
};

export type StoryTextOwner = {
  key: string;
  kind: "direct_yaml" | "composed_template" | "generated";
  editable: boolean;
  reason?: string;
  currentValue: string;
  sources: StoryTextSource[];
  relativePath?: string;
  fieldPath?: string;
  revision?: string;
  currentValueHash?: string;
  maxLength?: number;
  placeholders?: string[];
};

export type StoryTextEdit = {
  localization_key: string;
  expected_revision: string;
  expected_value_hash: string;
  next_value: string;
};

export type StoryTextSaveResult = {
  saved: boolean;
  errorCode?: string;
  issues: ValidationIssue[];
  runtime?: Runtime;
  owner?: StoryTextOwner;
  owners?: StoryTextOwner[];
};

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function authoringRoot(): string | undefined {
  if (!isTauri()) return undefined;
  try {
    const root = window.sessionStorage.getItem(AUTHORING_ROOT_KEY)?.trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

export function rememberAuthoringRoot(root: string): void {
  window.sessionStorage.setItem(AUTHORING_ROOT_KEY, root);
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("AUTHORING_UNAVAILABLE: Tauri 에디터에서만 사용할 수 있습니다.");
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(command, args);
}

export function getStoryTextOwner(root: string, localizationKey: string): Promise<StoryTextOwner> {
  return invoke("get_story_text_owner", { root, localizationKey });
}

export function saveStoryText(root: string, edits: StoryTextEdit[]): Promise<StoryTextSaveResult> {
  return invoke("save_story_text", { root, edits });
}

export function openStorySource(root: string, relativePath: string): Promise<void> {
  return invoke("open_source_location", { root, relativePath });
}

export function sourceLocator(source: StoryTextSource): string {
  const line = source.line ? `:${source.line}` : "";
  return `${source.relativePath}${line} · ${source.fieldPath}`;
}

export async function copySourceLocator(source: StoryTextSource): Promise<void> {
  await navigator.clipboard.writeText(sourceLocator(source));
}

export function returnToStoryEditor(): void {
  window.location.hash = "#/";
  window.location.reload();
}
