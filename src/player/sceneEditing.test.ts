import { describe, expect, it } from "vitest";
import { deleteNodeAndReconnect, deletionReplacement, incomingReferenceCount, insertNodeCopyAfter } from "../sceneEditing";
import type { Scene } from "../types";

function fixtureScene(): Scene {
  return {
    schema_version: 1,
    id: "test.scene",
    title: "테스트",
    route: "test",
    purpose: "연결 복구 테스트",
    cast: [],
    state_contract: { reads: [], writes: [] },
    start_node: "opening",
    node_order: ["opening", "choice", "remove_me", "closing"],
    nodes: {
      opening: { id: "opening", kind: "silent", perceived: { atmosphere: "dread", line: "" }, reality: { atmosphere: "dread", line: "" }, next: "remove_me" },
      choice: {
        id: "choice",
        kind: "choice",
        interaction_context: { kind: "not_applicable" },
        prompt: "선택",
        stimulus: "상황",
        options: [{
          id: "option_1",
          label: "계속",
          interpretation: "계속한다",
          action: "계속한다",
          push_pull: { action: "literal", intensity: 8, base_score: 2 },
          self_development: { expression: "health.test", equivalent_to: "option_1", converges_at: "remove_me" },
          conditions: [],
          effects: [],
          next: "remove_me",
        }],
      },
      remove_me: { id: "remove_me", kind: "silent", perceived: { atmosphere: "dread", line: "" }, reality: { atmosphere: "dread", line: "" }, next: "closing" },
      closing: { id: "closing", kind: "exit", transitions: [{ default: true, ending: true, ending_id: "test.end" }] },
    },
  };
}

describe("scene dialogue deletion", () => {
  it("chooses the deleted node's successor and rewires every inbound reference", () => {
    const scene = fixtureScene();
    expect(deletionReplacement(scene, "remove_me")).toBe("closing");
    expect(incomingReferenceCount(scene, "remove_me")).toBe(3);

    const rewired = deleteNodeAndReconnect(scene, "remove_me", "closing");

    expect(rewired).toBe(3);
    expect(scene.nodes.remove_me).toBeUndefined();
    expect(scene.node_order).toEqual(["opening", "choice", "closing"]);
    expect(scene.nodes.opening.next).toBe("closing");
    expect(scene.nodes.choice.options?.[0].next).toBe("closing");
    expect(scene.nodes.choice.options?.[0].self_development?.converges_at).toBe("closing");
  });

  it("does not offer deletion when no safe following screen exists", () => {
    const scene = fixtureScene();
    expect(deletionReplacement(scene, "closing")).toBeUndefined();
  });
});

describe("scene dialogue copy and paste", () => {
  it("deep-copies a node after the target and preserves the target's former continuation", () => {
    const scene = fixtureScene();
    const source = scene.nodes.remove_me;

    const copied = insertNodeCopyAfter(scene, source, "opening", "copied_dialogue");

    expect(scene.node_order).toEqual(["opening", "copied_dialogue", "choice", "remove_me", "closing"]);
    expect(scene.nodes.opening.next).toBe("copied_dialogue");
    expect(copied).toEqual({ ...source, id: "copied_dialogue", next: "remove_me" });
    expect(copied).not.toBe(source);
    expect(copied.perceived).not.toBe(source.perceived);
  });

  it("remaps copied self-references to the new node id", () => {
    const scene = fixtureScene();
    const source = scene.nodes.choice;
    source.options![0].next = "choice";
    source.options![0].self_development!.converges_at = "choice";

    const copied = insertNodeCopyAfter(scene, source, "remove_me", "copied_choice");

    expect(copied.options?.[0].next).toBe("copied_choice");
    expect(copied.options?.[0].self_development?.converges_at).toBe("copied_choice");
    expect(source.options?.[0].next).toBe("choice");
  });
});
