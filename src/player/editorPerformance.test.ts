import { describe, expect, it } from "vitest";
import {
  editorHistoryCommand,
  inactiveEditorPropsEqual,
  nextHistoryGroup,
  shouldCaptureHistory,
} from "../editorPerformance";

describe("editor performance policy", () => {
  it("coalesces continuous typing into one undo snapshot", () => {
    const first = nextHistoryGroup("node:intro", 1000);
    expect(shouldCaptureHistory(null, "node:intro", 1000)).toBe(true);
    expect(shouldCaptureHistory(first, "node:intro", 1300)).toBe(false);
    expect(shouldCaptureHistory(first, "node:intro", 1800)).toBe(true);
    expect(shouldCaptureHistory(first, "node:next", 1300)).toBe(true);
    expect(shouldCaptureHistory(first, undefined, 1300)).toBe(true);
  });

  it("recognizes undo and redo independently of the active keyboard layout", () => {
    expect(editorHistoryCommand({ key: "ㅋ", code: "KeyZ", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe("undo");
    expect(editorHistoryCommand({ key: "z", code: "KeyZ", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })).toBe("redo");
    expect(editorHistoryCommand({ key: "y", code: "KeyY", metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe("redo");
    expect(editorHistoryCommand({ key: "z", code: "KeyZ", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false })).toBeUndefined();
  });

  it("freezes only workspaces that remain inactive", () => {
    expect(inactiveEditorPropsEqual({ active: false }, { active: false })).toBe(true);
    expect(inactiveEditorPropsEqual({ active: false }, { active: true })).toBe(false);
    expect(inactiveEditorPropsEqual({ active: true }, { active: false })).toBe(false);
    expect(inactiveEditorPropsEqual({ active: true }, { active: true })).toBe(false);
  });
});
