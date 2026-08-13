import { describe, expect, it } from "vitest";
import type { StoryNode } from "../types";
import { nodePreview, stageForMode, withStageForMode } from "./scene";

describe("mobile scene compatibility", () => {
  it("shows a single-layer Mac dialogue instead of an empty placeholder", () => {
    const node = {
      id: "legacy-line",
      kind: "dialogue",
      line: "회의를 시작하겠습니다.",
      next: "leave",
    } as unknown as StoryNode;

    expect(nodePreview(node)).toBe("회의를 시작하겠습니다.");
  });

  it("uses a single-layer variant line in the sequence preview", () => {
    const node = {
      id: "legacy-variant",
      kind: "dialogue",
      variants: [
        { id: "default", default: true, line: "기본 조건 대사입니다." },
      ],
      next: "leave",
    } as unknown as StoryNode;

    expect(nodePreview(node)).toBe("기본 조건 대사입니다.");
  });

  it("keeps legacy stage cues as an array when artwork changes", () => {
    const node = {
      id: "legacy-stage",
      kind: "dialogue",
      line: "원화를 유지합니다.",
      stage: [],
    } as unknown as StoryNode;
    const cue = { position: "center" as const, character: "yoon_seo_a", visual_id: "character.yoon_seo_a", artwork: "default" };

    const updated = withStageForMode(node, "perceived", [cue]);

    expect(Array.isArray((updated as unknown as { stage: unknown }).stage)).toBe(true);
    expect(stageForMode(updated, "reality")).toEqual([cue]);
  });

  it("still prefers the perceived line for dual-layer dialogue", () => {
    const node = {
      id: "dual-line",
      kind: "dual_dialogue",
      perceived: { line: "겉으로 보이는 대사" },
      reality: { line: "실제 대사" },
    } as unknown as StoryNode;

    expect(nodePreview(node)).toBe("겉으로 보이는 대사");
  });
});
