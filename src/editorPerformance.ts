export const EDIT_HISTORY_GROUP_MS = 750;

export type EditHistoryGroup = {
  key: string;
  updatedAt: number;
};

type EditorHistoryKeyEvent = {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

export type EditorHistoryCommand = "undo" | "redo";

/**
 * Resolve editor-level history shortcuts independently of the active keyboard
 * layout. `code` keeps Ctrl/Cmd+Z working while a Korean IME is selected and
 * `key` remains as a fallback for synthetic and older WebView events.
 */
export function editorHistoryCommand(event: EditorHistoryKeyEvent): EditorHistoryCommand | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return undefined;
  const key = event.key.toLocaleLowerCase();
  const isZ = event.code === "KeyZ" || key === "z";
  if (isZ) return event.shiftKey ? "redo" : "undo";
  const isY = event.code === "KeyY" || key === "y";
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && isY) return "redo";
  return undefined;
}

export function shouldCaptureHistory(
  previous: EditHistoryGroup | null,
  key: string | undefined,
  now: number,
  windowMs = EDIT_HISTORY_GROUP_MS,
): boolean {
  if (!key || !previous) return true;
  return previous.key !== key || now - previous.updatedAt >= windowMs;
}

export function nextHistoryGroup(key: string | undefined, now: number): EditHistoryGroup | null {
  return key ? { key, updatedAt: now } : null;
}

/**
 * Hidden editor workspaces keep their local drafts mounted, but do not need to
 * render in response to scene-editor keystrokes. The next active transition
 * always renders with the latest props.
 */
export function inactiveEditorPropsEqual<T extends { active: boolean }>(previous: T, next: T): boolean {
  return !previous.active && !next.active;
}
