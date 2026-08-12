import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import { selfDevelopmentVariantDisplayName, systemDialogueFlows } from "./systemDialogueAuthoring";

const runtime = runtimeJson as unknown as Runtime;

describe("system dialogue authoring navigation", () => {
  it("organizes every physical system phrase into human-readable work units", () => {
    const flows = systemDialogueFlows(runtime);
    expect(flows.map((flow) => [flow.label, flow.fieldCount])).toEqual([
      ["밤 활동", 28],
      ["심리학 강사", 6],
    ]);
    expect(flows[0].groups.map((group) => [group.label, group.items.length])).toEqual([
      ["도입 대사", 2],
      ["활동 선택지", 6],
      ["활동 결과", 6],
    ]);
    expect(flows[1].groups[0].items.map((item) => item.label)).toEqual([
      "첫 선택 · 방향 미정",
      "대화를 이어갈 때",
      "말을 줄이고 물러날 때",
    ]);
  });

  it("pairs perceived and reality fields and creates an exact in-game preview target", () => {
    const result = systemDialogueFlows(runtime)[0].groups
      .find((group) => group.id === "results")!.items
      .find((item) => item.label === "OTT 시청")!;
    expect(result.rows.map((row) => row.fieldLabel)).toEqual([
      "화면 대사 · 주인공 인식",
      "실제 상황 · 원문 모드",
    ]);
    expect(result.previewTarget).toEqual({
      kind: "system_flow",
      flowId: "system.night_activity",
      nodeId: "activity_result",
      variantId: "ott",
      layer: "perceived",
    });
  });

  it("hides physical callback IDs behind writer-facing activity names", () => {
    expect(selfDevelopmentVariantDisplayName("after_workout")).toBe("운동");
    expect(selfDevelopmentVariantDisplayName("after_dark_psychology")).toBe("심리학 추가 학습");
    expect(selfDevelopmentVariantDisplayName("default")).toBe("그 외 · 활동 기록 없음");
  });
});
