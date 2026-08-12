import type { Scene, StoryNode } from "./types";

function cloneNode(node: StoryNode): StoryNode {
  return JSON.parse(JSON.stringify(node)) as StoryNode;
}

function remapSelfReferences(node: StoryNode, sourceId: string, copiedId: string): void {
  if (node.next === sourceId) node.next = copiedId;
  (node.options || []).forEach((option) => {
    if (option.next === sourceId) option.next = copiedId;
    if (option.self_development?.converges_at === sourceId) {
      option.self_development.converges_at = copiedId;
    }
  });
  (node.transitions || []).forEach((transition) => {
    if (transition.node === sourceId) transition.node = copiedId;
  });
}

function outgoingTargets(node: StoryNode): string[] {
  const targets = [
    node.next,
    ...(node.options || []).map((option) => option.next),
    ...(node.kind === "state_gate" ? (node.transitions || []).map((transition) => transition.node) : []),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(targets)];
}

export function insertNodeCopyAfter(scene: Scene, sourceNode: StoryNode, targetId: string, copiedId: string): StoryNode {
  const target = scene.nodes[targetId];
  if (!target) throw new Error(`unknown-target-node:${targetId}`);
  if (scene.nodes[copiedId]) throw new Error(`duplicate-node:${copiedId}`);

  const copied = cloneNode(sourceNode);
  copied.id = copiedId;
  remapSelfReferences(copied, sourceNode.id, copiedId);

  if (typeof target.next === "string") {
    const previousNext = target.next;
    target.next = copiedId;
    if (typeof copied.next === "string") copied.next = previousNext;
  }

  const targetIndex = scene.node_order.indexOf(targetId);
  const insertIndex = targetIndex >= 0 ? targetIndex + 1 : scene.node_order.length;
  scene.nodes[copiedId] = copied;
  scene.node_order.splice(insertIndex, 0, copiedId);
  return copied;
}

export function deletionReplacement(scene: Scene, nodeId: string): string | undefined {
  const node = scene.nodes[nodeId];
  if (!node) return undefined;
  const outgoing = outgoingTargets(node).filter((target) => target !== nodeId && Boolean(scene.nodes[target]));
  if (outgoing.length === 1) return outgoing[0];
  const index = scene.node_order.indexOf(nodeId);
  return scene.node_order.slice(index + 1).find((target) => target !== nodeId && Boolean(scene.nodes[target]));
}

export function incomingReferenceCount(scene: Scene, nodeId: string): number {
  let count = scene.start_node === nodeId ? 1 : 0;
  Object.values(scene.nodes).forEach((node) => {
    if (node.id === nodeId) return;
    if (node.next === nodeId) count += 1;
    count += (node.options || []).filter((option) => option.next === nodeId).length;
    count += (node.transitions || []).filter((transition) => transition.node === nodeId).length;
    count += (node.options || []).filter((option) => option.self_development?.converges_at === nodeId).length;
  });
  return count;
}

export function deleteNodeAndReconnect(scene: Scene, nodeId: string, replacementId: string): number {
  if (!scene.nodes[nodeId]) throw new Error(`unknown-node:${nodeId}`);
  if (replacementId === nodeId || !scene.nodes[replacementId]) throw new Error(`invalid-replacement:${replacementId}`);
  let rewired = 0;
  if (scene.start_node === nodeId) {
    scene.start_node = replacementId;
    rewired += 1;
  }
  Object.values(scene.nodes).forEach((node) => {
    if (node.id === nodeId) return;
    if (node.next === nodeId) {
      node.next = replacementId;
      rewired += 1;
    }
    (node.options || []).forEach((option) => {
      if (option.next === nodeId) {
        option.next = replacementId;
        rewired += 1;
      }
      if (option.self_development?.converges_at === nodeId) {
        option.self_development.converges_at = replacementId;
        rewired += 1;
      }
    });
    (node.transitions || []).forEach((transition) => {
      if (transition.node === nodeId) {
        transition.node = replacementId;
        rewired += 1;
      }
    });
  });
  delete scene.nodes[nodeId];
  scene.node_order = scene.node_order.filter((id) => id !== nodeId);
  return rewired;
}
