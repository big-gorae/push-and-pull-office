import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("editor persistence architecture", () => {
  it("keeps authoritative save commands behind repository ports", () => {
    const allowed = new Set(["../editorRepository.ts", "./storyAuthoring.ts"]);
    const violations = Object.entries(sources).flatMap(([path, source]) => {
      return /[\"']save_(scene|document|story_text)[\"']/.test(source)
        && !allowed.has(path)
        ? [path]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it("does not synchronously write editor drafts to localStorage", () => {
    const violations = Object.entries(sources).flatMap(([path, source]) => {
      return /localStorage\.setItem\([\s\S]{0,160}draft/i.test(source)
        ? [path]
        : [];
    });
    expect(violations).toEqual([]);
  });
});
