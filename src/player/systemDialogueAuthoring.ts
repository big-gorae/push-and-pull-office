import type { Runtime, ViewLayer } from "../types";
import type { SystemFlowAuthoringTarget } from "./storyAuthoring";

export type SystemDialogueFieldRole = "label" | "description" | ViewLayer;

export type SystemDialogueRow = {
  key: string;
  flowId: string;
  flowTitle: string;
  groupId: string;
  groupLabel: string;
  itemId: string;
  itemLabel: string;
  context: string;
  fieldRole: SystemDialogueFieldRole;
  fieldLabel: string;
  source: string;
  path: string;
  fieldPath: string;
};

export type SystemDialogueItem = {
  id: string;
  flowId: string;
  flowTitle: string;
  groupId: string;
  groupLabel: string;
  label: string;
  context: string;
  rows: SystemDialogueRow[];
  previewTarget: SystemFlowAuthoringTarget;
};

export type SystemDialogueGroup = {
  id: string;
  flowId: string;
  label: string;
  items: SystemDialogueItem[];
};

export type SystemDialogueFlow = {
  id: string;
  label: string;
  groups: SystemDialogueGroup[];
  fieldCount: number;
};

const FLOW_LABELS: Record<string, string> = {
  "system.night_activity": "밤 활동",
  "system.analysis_hint": "심리학 강사",
};

const GROUP_LABELS: Record<string, string> = {
  intro: "도입 대사",
  options: "활동 선택지",
  results: "활동 결과",
  analysis: "강사 분석",
};

const FLOW_ORDER = ["system.night_activity", "system.analysis_hint"];
const GROUP_ORDER = ["intro", "options", "results", "analysis"];
const ACTIVITY_ORDER = ["workout", "reading", "ott", "sleep", "dark_psychology", "solo_drinking"];
const ANALYSIS_ORDER = ["none", "pull", "push"];

const ITEM_LABELS: Record<string, string> = {
  intro: "귀가 후 활동 선택 전",
  forced_intro: "피로 누적 · 강제 활동 전",
  workout: "운동",
  reading: "독서",
  ott: "OTT 시청",
  sleep: "일찍 자기",
  dark_psychology: "심리학 추가 학습",
  solo_drinking: "강제 혼술",
  none: "첫 선택 · 방향 미정",
  pull: "대화를 이어갈 때",
  push: "말을 줄이고 물러날 때",
};

export function selfDevelopmentVariantDisplayName(variantId: string): string {
  return variantId === "default" ? "그 외 · 활동 기록 없음" : ITEM_LABELS[variantId.replace(/^after_/, "")] || variantId;
}

const CONTEXT_LABELS: Record<string, string> = {
  intro: "퇴근 후 집에 도착해 오늘의 활동을 고르기 직전에 표시됩니다.",
  forced_intro: "피로가 너무 높아 활동을 고르지 못하고 혼술로 넘어갈 때 표시됩니다.",
  workout: "밤 활동으로 운동을 마친 직후 표시됩니다.",
  reading: "밤 활동으로 독서를 마친 직후 표시됩니다.",
  ott: "밤 활동으로 OTT 시청을 마친 직후 표시됩니다.",
  sleep: "밤 활동으로 일찍 잠든 직후 표시됩니다.",
  dark_psychology: "심리학 강의를 추가로 학습한 직후 표시됩니다.",
  solo_drinking: "피로 누적으로 강제 혼술이 끝난 직후 표시됩니다.",
  none: "아직 밀당 방향이 정해지지 않은 첫 선택에서 표시됩니다.",
  pull: "현재 판정상 대화를 이어가는 선택이 유리할 때 표시됩니다.",
  push: "현재 판정상 말을 줄이고 물러나는 선택이 유리할 때 표시됩니다.",
};

const FIELD_ORDER: Record<SystemDialogueFieldRole, number> = {
  label: 0,
  description: 1,
  perceived: 0,
  reality: 1,
};

function orderedIndex(order: string[], value: string): number {
  const index = order.indexOf(value);
  return index >= 0 ? index : order.length;
}

function groupFor(flowId: string, nodeId?: string, optionId?: string): string {
  if (optionId) return "options";
  if (flowId === "system.analysis_hint") return "analysis";
  return nodeId === "activity_result" ? "results" : "intro";
}

function fieldRoleFor(fieldPath: string, layer?: ViewLayer): SystemDialogueFieldRole {
  if (layer) return layer;
  return fieldPath.endsWith(".description") ? "description" : "label";
}

function itemToken(nodeId?: string, variantId?: string, optionId?: string): string {
  return optionId || variantId || nodeId || "unknown";
}

function fieldLabel(role: SystemDialogueFieldRole): string {
  if (role === "perceived") return "화면 대사 · 주인공 인식";
  if (role === "reality") return "실제 상황 · 원문 모드";
  if (role === "description") return "화면 설명";
  return "화면 선택지";
}

function itemPreviewTarget(item: SystemDialogueRow[]): SystemFlowAuthoringTarget {
  const first = item[0];
  const entry = first.key.split(".");
  const nodeIndex = entry.indexOf("nodes");
  const variantIndex = entry.indexOf("variants");
  const optionIndex = entry.indexOf("options");
  const layer = item.find((row) => row.fieldRole === "perceived")?.fieldRole
    || item.find((row) => row.fieldRole === "reality")?.fieldRole;
  return {
    kind: "system_flow",
    flowId: first.flowId,
    ...(nodeIndex >= 0 ? { nodeId: entry[nodeIndex + 1] } : {}),
    ...(variantIndex >= 0 ? { variantId: entry[variantIndex + 1] } : {}),
    ...(optionIndex >= 0 ? { optionId: entry[optionIndex + 1] } : {}),
    ...(layer === "perceived" || layer === "reality" ? { layer } : {}),
  };
}

export function systemDialogueFlows(runtime: Runtime): SystemDialogueFlow[] {
  const rows = Object.values(runtime.localization.entries || {})
    .filter((entry) => entry.domain === "system_flow" && Boolean(entry.context.flowId))
    .map((entry): SystemDialogueRow => {
      const flowId = entry.context.flowId || "";
      const groupId = groupFor(flowId, entry.context.nodeId, entry.context.optionId);
      const token = itemToken(entry.context.nodeId, entry.context.variantId, entry.context.optionId);
      const role = fieldRoleFor(entry.sourceDocument.fieldPath, entry.context.layer);
      return {
        key: entry.key,
        flowId,
        flowTitle: FLOW_LABELS[flowId] || runtime.system_flows[flowId]?.title || flowId,
        groupId,
        groupLabel: GROUP_LABELS[groupId] || groupId,
        itemId: `${flowId}:${groupId}:${token}`,
        itemLabel: ITEM_LABELS[token] || token,
        context: groupId === "options"
          ? `${ITEM_LABELS[token] || token}를 고르는 화면에 표시됩니다.`
          : CONTEXT_LABELS[token] || "게임 흐름에서 조건을 만족할 때 표시됩니다.",
        fieldRole: role,
        fieldLabel: fieldLabel(role),
        source: entry.source,
        path: entry.sourceDocument.path,
        fieldPath: entry.sourceDocument.fieldPath,
      };
    });

  const flows = new Map<string, Map<string, Map<string, SystemDialogueRow[]>>>();
  rows.forEach((row) => {
    const groups = flows.get(row.flowId) || new Map<string, Map<string, SystemDialogueRow[]>>();
    const items = groups.get(row.groupId) || new Map<string, SystemDialogueRow[]>();
    items.set(row.itemId, [...(items.get(row.itemId) || []), row]);
    groups.set(row.groupId, items);
    flows.set(row.flowId, groups);
  });

  return [...flows.entries()]
    .map(([flowId, groupMap]): SystemDialogueFlow => {
      const groups = [...groupMap.entries()]
        .map(([groupId, itemMap]): SystemDialogueGroup => ({
          id: groupId,
          flowId,
          label: GROUP_LABELS[groupId] || groupId,
          items: [...itemMap.values()]
            .map((itemRows): SystemDialogueItem => {
              const sortedRows = [...itemRows].sort((left, right) => FIELD_ORDER[left.fieldRole] - FIELD_ORDER[right.fieldRole]);
              return {
                id: sortedRows[0].itemId,
                flowId,
                flowTitle: sortedRows[0].flowTitle,
                groupId,
                groupLabel: sortedRows[0].groupLabel,
                label: sortedRows[0].itemLabel,
                context: sortedRows[0].context,
                rows: sortedRows,
                previewTarget: itemPreviewTarget(sortedRows),
              };
            })
            .sort((left, right) => {
              const order = groupId === "analysis" ? ANALYSIS_ORDER : ACTIVITY_ORDER;
              const leftToken = left.id.split(":").at(-1) || "";
              const rightToken = right.id.split(":").at(-1) || "";
              if (groupId === "intro") return leftToken === "intro" ? -1 : rightToken === "intro" ? 1 : leftToken.localeCompare(rightToken);
              return orderedIndex(order, leftToken) - orderedIndex(order, rightToken);
            }),
        }))
        .sort((left, right) => orderedIndex(GROUP_ORDER, left.id) - orderedIndex(GROUP_ORDER, right.id));
      return {
        id: flowId,
        label: FLOW_LABELS[flowId] || runtime.system_flows[flowId]?.title || flowId,
        groups,
        fieldCount: groups.reduce((count, group) => count + group.items.reduce((sum, item) => sum + item.rows.length, 0), 0),
      };
    })
    .sort((left, right) => orderedIndex(FLOW_ORDER, left.id) - orderedIndex(FLOW_ORDER, right.id));
}

export function systemDialogueSourceFingerprint(rows: SystemDialogueRow[]): string {
  return JSON.stringify(rows.map((row) => [row.key, row.source]));
}
