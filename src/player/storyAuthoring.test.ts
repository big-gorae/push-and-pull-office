import { describe, expect, it } from "vitest";
import { authoringRoot, sourceLocator } from "./storyAuthoring";

describe("story authoring boundary", () => {
  it("stays disabled outside the Tauri production surface", () => {
    expect(authoringRoot()).toBeUndefined();
  });

  it("copies a stable source locator without exposing an absolute path", () => {
    expect(sourceLocator({
      label: "원본 YAML",
      relativePath: "story/scenes/seo_a/email_request.yaml",
      fieldPath: "nodes.request.reality.line",
      line: 42,
    })).toBe("story/scenes/seo_a/email_request.yaml:42 · nodes.request.reality.line");
  });
});
