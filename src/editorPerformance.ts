export const EDIT_HISTORY_GROUP_MS = 750;

export type EditHistoryGroup = {
  key: string;
  updatedAt: number;
};

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
