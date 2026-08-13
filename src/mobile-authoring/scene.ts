import { deleteNodeAndReconnect, deletionReplacement, insertNodeCopyAfter } from "../sceneEditing";
import type { DialogueVariant, Layer, NodeKind, Scene, StageCharacterCue, StoryNode, ViewMode } from "../types";

export type LegacyDialogueKind = "dialogue" | "narration";
export type EditableDialogueKind = NodeKind | LegacyDialogueKind;
export type CompatibleDialogueVariant = DialogueVariant & { line?: string };
export type CompatibleStoryNode = StoryNode & {
  kind: EditableDialogueKind;
  line?: string;
  atmosphere?: string;
  expression?: string;
  variants?: CompatibleDialogueVariant[];
  stage?: StoryNode["stage"] | StageCharacterCue[];
};

export const MOBILE_NODE_LABELS: Partial<Record<EditableDialogueKind, string>> = {
  dual_dialogue: "대사",
  dual_narration: "나레이션",
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
  const variants = (node.variants || []) as CompatibleDialogueVariant[];
  const texts = [
    compatible.line,
    node.perceived?.line,
    node.reality?.line,
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

export function compatibleVariants(node: StoryNode): CompatibleDialogueVariant[] {
  return (node.variants || []) as CompatibleDialogueVariant[];
}

export function isLegacyDialogueNode(node: StoryNode): node is CompatibleStoryNode {
  return (node.kind as string) === "dialogue" || (node.kind as string) === "narration";
}

export function isEditableDialogueNode(node: StoryNode): boolean {
  return ["dual_dialogue", "dual_narration", "dialogue", "narration"].includes(node.kind as string);
}

export function isDialogueNode(node: StoryNode): boolean {
  return (node.kind as string) === "dual_dialogue" || (node.kind as string) === "dialogue";
}

export function dialogueLayer(node: StoryNode, mode: ViewMode): Layer {
  if (isLegacyDialogueNode(node)) return node;
  return node[mode] || {};
}

export function stageForMode(node: StoryNode, mode: ViewMode): StageCharacterCue[] {
  const stage = (node as CompatibleStoryNode).stage;
  return Array.isArray(stage) ? stage : stage?.[mode] || [];
}

export function withStageForMode(node: StoryNode, mode: ViewMode, stage: StageCharacterCue[]): StoryNode {
  if (isLegacyDialogueNode(node) || Array.isArray((node as CompatibleStoryNode).stage)) {
    return { ...node, stage } as StoryNode;
  }
  return { ...node, stage: { ...(node.stage || {}), [mode]: stage } };
}

export function automaticNodeId(scene: Scene): string {
  const token = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`;
  let id = `dialogue_${token}`;
  let suffix = 2;
  while (scene.nodes[id]) id = `dialogue_${token}_${suffix++}`;
  return id;
}

export function newMobileNode(kind: "dual_dialogue" | "dual_narration", id: string, speaker?: string): StoryNode {
  const base = {
    id,
    kind,
    perceived: { atmosphere: "neutral", line: "새 문장을 입력하세요." },
    reality: { atmosphere: "neutral", line: "새 문장을 입력하세요.", intent: "work_only" },
    line_layers_locked: true,
    next: "",
  } satisfies StoryNode;
  return kind === "dual_dialogue" ? { ...base, speaker: speaker || "" } : base;
}

export function addNodeAfter(scene: Scene, targetId: string, kind: "dual_dialogue" | "dual_narration", speaker?: string): string {
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

export function changeDialogueKind(node: StoryNode, kind: "dual_dialogue" | "dual_narration" | LegacyDialogueKind, defaultSpeaker?: string): StoryNode {
  if (node.kind === kind) return node;
  if (!isEditableDialogueNode(node)) return node;
  if (kind === "dual_narration" || kind === "narration") {
    const { speaker: _speaker, speakers: _speakers, ...rest } = node;
    return { ...rest, kind } as StoryNode;
  }
  return { ...node, kind, speaker: node.speaker || defaultSpeaker || "" } as StoryNode;
}

export function allowsProtagonistArtwork(scene: Scene, node: StoryNode): boolean {
  return scene.id.startsWith("ending.")
    && ((node.kind as string) === "dual_narration" || (node.kind as string) === "narration")
    && Boolean(node.presentation_flags?.includes("protagonist_art_reveal"));
}
