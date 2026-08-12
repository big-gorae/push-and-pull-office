import type { ProjectPayload, Runtime, ValidationIssue, ViewLayer } from "../types";

const AUTHORING_ROOT_KEY = "love-office:authoring-root";
const AUTHORING_PLAY_WINDOW = "authoring-play";
const AUTHORING_NAVIGATE_EVENT = "authoring:navigate";
const AUTHORING_PREVIEW_EVENT = "authoring:preview-dialogue";
const AUTHORING_PREVIEW_TARGET_KEY = "love-office:authoring-preview-target";

export type StoryTextSource = {
  label: string;
  relativePath: string;
  fieldPath: string;
  line?: number;
  column?: number;
  editable?: boolean;
  currentValue?: string;
  currentValueHash?: string;
  revision?: string;
  placeholders?: string[];
  maxLength?: number;
};

export type StoryTextOwner = {
  key: string;
  kind: "direct_yaml" | "generated";
  editable: boolean;
  reason?: string;
  currentValue: string;
  locale?: string;
  isTranslation?: boolean;
  translationExists?: boolean;
  sourceValue?: string;
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
  locale?: string;
  expected_revision: string;
  expected_value_hash: string;
  next_value?: string;
  delete?: boolean;
  source_relative_path?: string;
  source_field_path?: string;
};

export type StoryTextChange = {
  localizationKey: string;
  locale?: string | null;
  relativePath: string;
  fieldPath: string;
  beforeValue: string;
  beforeExists: boolean;
  afterValue?: string;
  afterExists: boolean;
  sourceEdit: boolean;
};

export type StoryTextSaveResult = {
  saved: boolean;
  errorCode?: string;
  issues: ValidationIssue[];
  runtime?: Runtime;
  documents?: ProjectPayload["documents"];
  owner?: StoryTextOwner;
  owners?: StoryTextOwner[];
  changes?: StoryTextChange[];
};

export type SourceEditor = "system" | "vscode" | "cursor" | "zed";

export type SceneAuthoringTarget = {
  kind?: "scene";
  sceneId: string;
  nodeId?: string;
};

export type SystemFlowAuthoringTarget = {
  kind: "system_flow";
  flowId: string;
  nodeId?: string;
  variantId?: string;
  optionId?: string;
  layer?: ViewLayer;
};

export type AuthoringTarget = SceneAuthoringTarget | SystemFlowAuthoringTarget;

export function parseAuthoringTarget(raw: string | null): AuthoringTarget | undefined {
  if (!raw) return undefined;
  try {
    const target = JSON.parse(raw) as Record<string, unknown>;
    if (target.kind === "system_flow" && typeof target.flowId === "string") {
      return {
        kind: "system_flow",
        flowId: target.flowId,
        ...(typeof target.nodeId === "string" ? { nodeId: target.nodeId } : {}),
        ...(typeof target.variantId === "string" ? { variantId: target.variantId } : {}),
        ...(typeof target.optionId === "string" ? { optionId: target.optionId } : {}),
        ...(target.layer === "perceived" || target.layer === "reality" ? { layer: target.layer as ViewLayer } : {}),
      };
    }
    return typeof target.sceneId === "string"
      ? { kind: "scene", sceneId: target.sceneId, nodeId: typeof target.nodeId === "string" ? target.nodeId : undefined }
      : undefined;
  } catch {
    return undefined;
  }
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function authoringRoot(): string | undefined {
  if (!isTauri()) return undefined;
  try {
    // sessionStorage is isolated per WebView.  Keep the approved project root in
    // localStorage too so the companion play window can use the same Tauri bridge.
    const root = (window.sessionStorage.getItem(AUTHORING_ROOT_KEY)
      || window.localStorage.getItem(AUTHORING_ROOT_KEY))?.trim();
    return root || undefined;
  } catch {
    return undefined;
  }
}

export function rememberAuthoringRoot(root: string): void {
  window.sessionStorage.setItem(AUTHORING_ROOT_KEY, root);
  window.localStorage.setItem(AUTHORING_ROOT_KEY, root);
}

async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("AUTHORING_UNAVAILABLE: Tauri 에디터에서만 사용할 수 있습니다.");
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(command, args);
}

export function getStoryTextOwner(root: string, localizationKey: string, locale?: string): Promise<StoryTextOwner> {
  return invoke("get_story_text_owner", { root, localizationKey, locale });
}

export function saveStoryText(root: string, edits: StoryTextEdit[]): Promise<StoryTextSaveResult> {
  return invoke("save_story_text", { root, edits });
}

export function openStorySource(root: string, source: StoryTextSource, editor: SourceEditor): Promise<void> {
  return invoke("open_source_location", {
    root,
    relativePath: source.relativePath,
    line: source.line,
    column: source.column,
    editor,
  });
}

export function revealStorySource(root: string, source: StoryTextSource): Promise<void> {
  return invoke("reveal_in_file_manager", { root, relativePath: source.relativePath });
}

export function sourceLocator(source: StoryTextSource): string {
  const position = source.line ? `:${source.line}${source.column ? `:${source.column}` : ""}` : "";
  return `${source.relativePath}${position} · ${source.fieldPath}`;
}

export async function copySourceLocator(source: StoryTextSource): Promise<void> {
  await navigator.clipboard.writeText(sourceLocator(source));
}

export function readSourceEditor(): SourceEditor {
  try {
    const value = window.localStorage.getItem("love-office:source-editor");
    return value === "vscode" || value === "cursor" || value === "zed" ? value : "system";
  } catch {
    return "system";
  }
}

export function writeSourceEditor(editor: SourceEditor): void {
  window.localStorage.setItem("love-office:source-editor", editor);
}

export function runtimeTextValues(runtime: Runtime, keys: string[], locale: string): Record<string, string> {
  const catalog = locale === runtime.localization.default_locale
    ? runtime.localization.source_strings
    : runtime.localization.resolved_catalogs?.[locale]
      || runtime.localization.catalogs[locale]
      || runtime.localization.source_strings;
  return Object.fromEntries(keys.map((key) => [key, catalog[key] || runtime.localization.source_strings[key] || key]));
}

export function inverseStoryTextEdits(
  changes: StoryTextChange[],
  refreshedOwners: StoryTextOwner[],
  fallbackLocale: string,
): StoryTextEdit[] {
  return changes.flatMap((change): StoryTextEdit[] => {
    const owner = refreshedOwners.find((candidate) => candidate.key === change.localizationKey);
    if (!owner) return [];
    const current = change.sourceEdit
      ? owner.sources.find((source) => source.relativePath === change.relativePath && source.fieldPath === change.fieldPath)
      : owner;
    if (!current?.revision || !current.currentValueHash) return [];
    return [{
      localization_key: change.localizationKey,
      locale: change.locale || fallbackLocale,
      ...(change.sourceEdit ? {
        source_relative_path: change.relativePath,
        source_field_path: change.fieldPath,
      } : {}),
      expected_revision: current.revision,
      expected_value_hash: current.currentValueHash,
      ...(change.beforeExists ? { next_value: change.beforeValue } : { delete: true }),
    }];
  });
}

export async function openAuthoringPlayWindow(root: string, target?: AuthoringTarget): Promise<void> {
  if (!isTauri()) throw new Error("AUTHORING_UNAVAILABLE: Tauri 에디터에서만 사용할 수 있습니다.");
  rememberAuthoringRoot(root);
  if (target) window.localStorage.setItem(AUTHORING_PREVIEW_TARGET_KEY, JSON.stringify(target));
  const [{ WebviewWindow }, { emitTo }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/event"),
  ]);
  const existing = await WebviewWindow.getByLabel(AUTHORING_PLAY_WINDOW);
  if (existing) {
    if (target) await emitTo(AUTHORING_PLAY_WINDOW, AUTHORING_PREVIEW_EVENT, target);
    await existing.show();
    await existing.setFocus();
    return;
  }
  const playWindow = new WebviewWindow(AUTHORING_PLAY_WINDOW, {
    url: "#/play?authoring=1",
    title: "밀당 오피스 · 게임 대사 편집",
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
  });
  await new Promise<void>((resolve, reject) => {
    playWindow.once("tauri://created", () => resolve());
    playWindow.once("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}

export function consumeAuthoringPreviewTarget(): AuthoringTarget | undefined {
  try {
    const raw = window.localStorage.getItem(AUTHORING_PREVIEW_TARGET_KEY);
    window.localStorage.removeItem(AUTHORING_PREVIEW_TARGET_KEY);
    return parseAuthoringTarget(raw);
  } catch {
    return undefined;
  }
}

export async function returnToStoryEditor(target?: AuthoringTarget): Promise<void> {
  if (!isTauri()) return;
  const [{ emitTo }, { WebviewWindow }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/webviewWindow"),
  ]);
  if (target) await emitTo("main", AUTHORING_NAVIGATE_EVENT, target);
  const editor = await WebviewWindow.getByLabel("main");
  if (editor) {
    await editor.show();
    await editor.setFocus();
  }
}

export function consumeAuthoringTarget(): AuthoringTarget | undefined {
  try {
    const raw = window.sessionStorage.getItem("love-office:authoring-target");
    window.sessionStorage.removeItem("love-office:authoring-target");
    return parseAuthoringTarget(raw);
  } catch {
    return undefined;
  }
}
