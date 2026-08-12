import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import {
  authoringRoot,
  inverseStoryTextEdits,
  parseAuthoringTarget,
  runtimeTextValues,
  sourceLocator,
} from "./storyAuthoring";

const runtime = runtimeJson as unknown as Runtime;

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
      column: 7,
    })).toBe("story/scenes/seo_a/email_request.yaml:42:7 · nodes.request.reality.line");
  });

  it("reads hot-reload values from the edited locale catalog", () => {
    const key = "scenes.seo_a.email_request.nodes.request.reality.line";
    expect(runtimeTextValues(runtime, [key], "ko")[key]).toBe(runtime.localization.source_strings[key]);
    expect(runtimeTextValues(runtime, [key], "en")[key]).toBe(runtime.localization.resolved_catalogs?.en[key]);
  });

  it("builds a guarded inverse patch for a newly created translation", () => {
    const key = "scenes.example.nodes.line.reality.line";
    const edits = inverseStoryTextEdits([{
      localizationKey: key,
      locale: "en",
      relativePath: "story/locales/en.yaml",
      fieldPath: `strings.${key}`,
      beforeValue: "한국어 원문",
      beforeExists: false,
      afterValue: "English translation",
      afterExists: true,
      sourceEdit: false,
    }], [{
      key,
      kind: "direct_yaml",
      editable: true,
      currentValue: "English translation",
      currentValueHash: "new-value-hash",
      revision: "new-revision",
      sources: [],
    }], "ko");

    expect(edits).toEqual([{
      localization_key: key,
      locale: "en",
      expected_revision: "new-revision",
      expected_value_hash: "new-value-hash",
      delete: true,
    }]);
  });

  it("builds a source-owned inverse patch for a physical system dialogue", () => {
    const key = "system_flows.system.night_activity.nodes.activity_result.variants.workout.reality.line";
    const source = {
      label: "운동 활동 문구",
      relativePath: "story/system_flows/night_activity.yaml",
      fieldPath: "nodes.activity_result.variants.workout.reality.line",
      revision: "new-revision",
      currentValue: "새 활동 문구",
      currentValueHash: "new-value-hash",
      editable: true,
    };
    const edits = inverseStoryTextEdits([{
      localizationKey: key,
      relativePath: source.relativePath,
      fieldPath: source.fieldPath,
      beforeValue: "이전 활동 문구",
      beforeExists: true,
      afterValue: "새 활동 문구",
      afterExists: true,
      sourceEdit: true,
    }], [{ key, kind: "direct_yaml", editable: true, currentValue: "새 활동 문구", sources: [source] }], "ko");

    expect(edits[0]).toMatchObject({
      localization_key: key,
      locale: "ko",
      source_relative_path: source.relativePath,
      source_field_path: source.fieldPath,
      expected_revision: "new-revision",
      expected_value_hash: "new-value-hash",
      next_value: "이전 활동 문구",
    });
  });

  it("round-trips an exact system-flow preview target", () => {
    expect(parseAuthoringTarget(JSON.stringify({
      kind: "system_flow",
      flowId: "system.night_activity",
      nodeId: "activity_result",
      variantId: "reading",
      layer: "reality",
    }))).toEqual({
      kind: "system_flow",
      flowId: "system.night_activity",
      nodeId: "activity_result",
      variantId: "reading",
      layer: "reality",
    });
  });
});
