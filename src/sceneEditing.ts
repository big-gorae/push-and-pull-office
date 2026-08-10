import type { Scene, StoryNode } from "./types";

function outgoingTargets(node: StoryNode): string[] {
  const targets = [
    node.next,
    ...(node.options || []).map((option) => option.next),
    ...(node.kind === "state_gate" ? (node.transitions || []).map((transition) => transition.node) : []),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(targets)];
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
