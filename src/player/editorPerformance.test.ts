import { describe, expect, it } from "vitest";
import {
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

  it("freezes only workspaces that remain inactive", () => {
    expect(inactiveEditorPropsEqual({ active: false }, { active: false })).toBe(true);
    expect(inactiveEditorPropsEqual({ active: false }, { active: true })).toBe(false);
    expect(inactiveEditorPropsEqual({ active: true }, { active: false })).toBe(false);
    expect(inactiveEditorPropsEqual({ active: true }, { active: true })).toBe(false);
  });
});
