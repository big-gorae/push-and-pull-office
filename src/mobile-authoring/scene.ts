import { deleteNodeAndReconnect, deletionReplacement, insertNodeCopyAfter } from "../sceneEditing";
import type { NodeKind, Scene, StageCharacterCue, StoryNode } from "../types";

type CompatibleLayer = { line?: string };
type CompatibleVariant = { line?: string; perceived?: CompatibleLayer; reality?: CompatibleLayer };
type CompatibleStoryNode = StoryNode & {
  perceived?: CompatibleLayer;
  reality?: CompatibleLayer;
  variants?: CompatibleVariant[];
  stage?: StoryNode["stage"] | Record<string, StageCharacterCue[]>;
};

export const MOBILE_NODE_LABELS: Partial<Record<NodeKind, string>> = {
  dialogue: "대사",
  narration: "나레이션",
  silent: "무대사 연출",
  choice: "선택지",
  state_gate: "수치 분기",
  effect: "상태 효과",
  exit: "장면 이탈",
};

export function cloneScene(scene: Scene): Scene {
  return structuredClone(scene);
}

export function nodePreview(node: StoryNode | undefined): string {
  if (!node) return "대사를 찾을 수 없음";
  const compatible = node as CompatibleStoryNode;
  const variants = (node.variants || []) as CompatibleVariant[];
  const texts = [
    node.line,
    compatible.perceived?.line,
    compatible.reality?.line,
    ...variants.flatMap((variant) => [variant.line, variant.perceived?.line, variant.reality?.line]),
    node.prompt,
    node.stimulus,
    ...(node.options || []).flatMap((option) => [option.label, option.action]),
  ];
  return texts.find((value) => typeof value === "string" && value.trim())?.trim()
    || (node.kind === "silent" ? "배경과 원화만 표시"
      : node.kind === "effect" || node.kind === "state_gate" || node.kind === "exit" ? "화면 표시 없는 진행 노드"
        : "비어 있는 대사");
}

export function stageForMode(node: StoryNode, mode: "perceived" | "reality"): StageCharacterCue[] {
  const stage = (node as CompatibleStoryNode).stage;
  return Array.isArray(stage) ? stage : stage?.[mode] || [];
}

export function withStageForMode(node: StoryNode, _mode: "perceived" | "reality", stage: StageCharacterCue[]): StoryNode {
  return { ...node, stage };
}

export function automaticNodeId(scene: Scene): string {
  const token = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
  let id = `dialogue_${token}`;
  let suffix = 2;
  while (scene.nodes[id]) id = `dialogue_${token}_${suffix++}`;
  return id;
}

export function newMobileNode(kind: "dialogue" | "narration", id: string, speaker?: string): StoryNode {
  const base = {
    id,
    kind,
    line: "새 문장을 입력하세요.",
    next: "",
  } satisfies StoryNode;
  return kind === "dialogue" ? { ...base, speaker: speaker || "" } : base;
}

export function addNodeAfter(scene: Scene, targetId: string, kind: "dialogue" | "narration", speaker?: string): string {
  const id = automaticNodeId(scene);
  const target = scene.nodes[targetId];
  const node = newMobileNode(kind, id, speaker);
  if (target && typeof target.next === "string") {
    node.next = target.next;
    target.next = id;
  } else {
    const targetIndex = scene.node_order.indexOf(targetId);
    node.next = scene.node_order[targetIndex + 1] || "";
  }
  scene.nodes[id] = node;
  const index = scene.node_order.indexOf(targetId);
  scene.node_order.splice(index >= 0 ? index + 1 : scene.node_order.length, 0, id);
  return id;
}

export function copyNodeAfter(scene: Scene, source: StoryNode, targetId: string): string {
  const id = automaticNodeId(scene);
  insertNodeCopyAfter(scene, source, targetId, id);
  return id;
}

export function removeNode(scene: Scene, nodeId: string): string | undefined {
  if (scene.node_order.length <= 1) return undefined;
  const replacement = deletionReplacement(scene, nodeId);
  if (!replacement) return undefined;
  deleteNodeAndReconnect(scene, nodeId, replacement);
  return replacement;
}

export function moveNode(scene: Scene, nodeId: string, offset: number): boolean {
  const index = scene.node_order.indexOf(nodeId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= scene.node_order.length) return false;
  [scene.node_order[index], scene.node_order[target]] = [scene.node_order[target], scene.node_order[index]];
  return true;
}

export function changeDialogueKind(node: StoryNode, kind: "dialogue" | "narration", defaultSpeaker?: string): StoryNode {
  if (node.kind === kind) return node;
  if (!(["dialogue", "narration"] as NodeKind[]).includes(node.kind)) return node;
  if (kind === "narration") {
    const { speaker: _speaker, ...rest } = node;
    return { ...rest, kind };
  }
  return { ...node, kind, speaker: node.speaker || defaultSpeaker || "" } as StoryNode;
}

export function allowsProtagonistArtwork(scene: Scene, node: StoryNode): boolean {
  return scene.id.startsWith("ending.")
    && node.kind === "narration"
    && Boolean(node.presentation_flags?.includes("protagonist_art_reveal"));
}
