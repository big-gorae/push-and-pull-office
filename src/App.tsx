import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import TimelineEditor from "./TimelineEditor";
import PresentationEditor from "./PresentationEditor";
import CharacterEditor from "./CharacterEditor";
import ProjectSettingsEditor, { type SettingsKind, type SettingsRequest } from "./ProjectSettingsEditor";
import SystemDialogueEditor from "./SystemDialogueEditor";
import QuickOpen, { type QuickOpenItem } from "./QuickOpen";
import DuplicateDialog from "./DuplicateDialog";
import ArtworkStageEditor from "./ArtworkStageEditor";
import { applyDialogueSpeakerSelection } from "./stageAuthoring";
import SceneBackgroundEditor from "./SceneBackgroundEditor";
import { useDocumentAutosave, useSaveCommandBinding } from "./editorAutosave";
import { editorDraftJournal, useDraftJournal } from "./editorDraftJournal";
import { editorSaveRepository } from "./editorRepository";
import { inactiveEditorPropsEqual, nextHistoryGroup, shouldCaptureHistory, type EditHistoryGroup } from "./editorPerformance";
import { editorSaveCoordinator, SaveFailure, type DocumentSnapshot, type SaveCommitResult, type SaveCompletion, type SaveState } from "./editorSave";
import { resolveRuntimeUpdate, type RuntimePatch, type RuntimeUpdate } from "./runtimePatch";
import { selfDevelopmentVariantDisplayName } from "./player/systemDialogueAuthoring";
import { deleteNodeAndReconnect, deletionReplacement, incomingReferenceCount, insertNodeCopyAfter } from "./sceneEditing";
import {
  consumeAuthoringTarget,
  openAuthoringPlayWindow,
  rememberAuthoringRoot,
  type AuthoringTarget,
  type SystemFlowAuthoringTarget,
} from "./player/storyAuthoring";
import {
  pushPullPositionLabel,
  pushPullTargetLabel,
  readPushPullState,
  resolvePushPull,
  writePushPullState,
  type PushPullResult,
  type PushPullTarget,
} from "./pushPull";
import {
  applyEffect,
  canEnterScene,
  chooseTransition,
  clone,
  conditionsMatch,
  deriveEmotion,
  deriveStateContract,
  effectiveSpeaker,
  getPath,
  makeNode,
  parseEditorValue,
  resolveDialogueNode,
  resolveStart,
  statePaths,
} from "./storyLogic";
import { selfDevelopmentSystem } from "./selfDevelopment";
import type {
  Character,
  ChoiceOption,
  Condition,
  DecisionTrace,
  DialogueVariant,
  DocumentActivity,
  Effect,
  InteractionContextKind,
  JsonValue,
  Layer,
  NodeKind,
  ProjectPayload,
  Runtime,
  RuntimeState,
  Scene,
  StoryNode,
  SupportStyle,
  Transition,
  ValidationIssue,
  ViewMode,
} from "./types";

const NODE_LABELS: Record<NodeKind, string> = {
  dual_dialogue: "대사",
  dual_narration: "내레이션",
  silent: "무대사",
  choice: "선택지",
  state_gate: "수치 분기",
  effect: "상태 효과",
  exit: "장면 이탈",
};

const SUPPORT_STYLE_OPTIONS: Array<{ id: SupportStyle; label: string }> = [
  { id: "emotional_validation", label: "감정 인정" },
  { id: "factual_clarification", label: "사실 확인" },
  { id: "practical_resolution", label: "실행 가능한 해결" },
  { id: "ask_before_helping", label: "돕기 전 질문" },
  { id: "autonomy_return", label: "선택권 반환" },
  { id: "concise_reassurance", label: "짧고 구체적인 안심" },
  { id: "literal_respect", label: "말의 원문 존중" },
];

const INTERACTION_CONTEXT_OPTIONS: Array<{ id: InteractionContextKind; label: string }> = [
  { id: "support", label: "지원이 필요한 상황" },
  { id: "coordination", label: "업무 조율 상황" },
  { id: "boundary", label: "명시적 요청·경계 상황" },
  { id: "not_applicable", label: "MBTI 요소 적용 안 함" },
];

const STATE_LABELS: Record<string, string> = { push: "밀기", pull: "당기기", neutral: "중립" };

type HistoryState = { past: Scene[]; future: Scene[] };
type SceneCommitResult = SaveCommitResult & RuntimeUpdate & {
  document: ProjectPayload["documents"]["scenes"][string];
  issues: ValidationIssue[];
};
type DialogueClipboard = { node: StoryNode; sourceSceneId: string };
type DialogueContextMenuState = { nodeId: string; x: number; y: number };
type Workspace = "timeline" | "scene" | "system" | "character" | "presentation" | "settings";
const WORKSPACES: Workspace[] = ["timeline", "scene", "system", "character", "presentation", "settings"];
const DeferredTimelineEditor = memo(TimelineEditor, inactiveEditorPropsEqual);
const DeferredCharacterEditor = memo(CharacterEditor, inactiveEditorPropsEqual);
const DeferredPresentationEditor = memo(PresentationEditor, inactiveEditorPropsEqual);
const DeferredProjectSettingsEditor = memo(ProjectSettingsEditor, inactiveEditorPropsEqual);
const DeferredSystemDialogueEditor = memo(SystemDialogueEditor, inactiveEditorPropsEqual);

function initialWorkspace(): Workspace {
  try {
    const stored = localStorage.getItem("love-office:last-workspace") as Workspace | null;
    return stored && WORKSPACES.includes(stored) ? stored : "timeline";
  } catch {
    return "timeline";
  }
}

function initialStoryFlowCollapsed(): boolean {
  try {
    return localStorage.getItem("love-office:story-flow-collapsed") === "true";
  } catch {
    return false;
  }
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={wide ? "field field-wide" : "field"}><span>{label}</span>{children}</label>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} />;
}

const DialogueFlowRow = memo(function DialogueFlowRow({
  id,
  index,
  preview,
  kindLabel,
  active,
  onSelect,
  onContextMenu,
}: {
  id: string;
  index: number;
  preview: string;
  kindLabel: string;
  active: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (id: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return <button
    type="button"
    role="listitem"
    className={active ? "node-pill active" : "node-pill"}
    title="클릭하여 선택 · 우클릭하여 복사 또는 붙여넣기"
    onClick={() => onSelect(id)}
    onContextMenu={(event) => onContextMenu(id, event)}
  >
    <b>{index + 1}</b><span>{preview}</span><small>{kindLabel}</small>
  </button>;
});

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function IconText({ children }: { children: ReactNode }) {
  return <span aria-hidden="true" className="icon-text">{children}</span>;
}

function valueText(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function nodeScreenTexts(node: StoryNode): string[] {
  const direct = [node.perceived?.line, node.reality?.line, node.prompt, node.stimulus];
  const variants = [...(node.variants || [])]
    .sort((left, right) => Number(Boolean(right.default)) - Number(Boolean(left.default)))
    .flatMap((variant) => [variant.perceived?.line, variant.reality?.line]);
  const choices = node.kind === "choice"
    ? (node.options || []).flatMap((option) => [option.label, option.action, option.interpretation])
    : [];
  return [...direct, ...variants, ...choices]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
}

function nodePreview(node: StoryNode): string {
  return nodeScreenTexts(node)[0]
    || (node.kind === "silent" ? "무대사 · 배경과 원화 감상"
      : node.kind === "state_gate" ? "화면 표시 없음 · 조건에 따라 다음 대사로 이동"
      : node.kind === "effect" ? "화면 표시 없음 · 상태 변경"
        : node.kind === "exit" ? "화면 표시 없음 · 다음 장면으로 이동"
          : "화면 대사가 비어 있습니다");
}

function dialogueOptionLabel(scene: Scene, id: string): string {
  const index = scene.node_order.indexOf(id);
  const node = scene.nodes[id];
  return node ? `${index + 1}. ${nodePreview(node)}` : "삭제되었거나 찾을 수 없는 대사";
}

function automaticDialogueId(scene: Scene): string {
  const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  let id = `dialogue_${token}`;
  let suffix = 2;
  while (scene.nodes[id]) {
    id = `dialogue_${token}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function validationAgentPrompt(issues: ValidationIssue[]): string {
  const actionable = issues.filter((issue) => issue.severity === "error" || issue.severity === "warning");
  const errorCount = actionable.filter((issue) => issue.severity === "error").length;
  const warningCount = actionable.filter((issue) => issue.severity === "warning").length;
  const issueLines = actionable.flatMap((issue, index) => [
    `${index + 1}. [${issue.severity.toUpperCase()}] ${issue.message}`,
    `   위치: ${issue.location}`,
  ]);

  return [
    "Love Office의 아래 검증 오류와 경고를 모두 수정해줘.",
    "AGENTS.md와 story/AI_AUTHORING_RULES.md, story/SPEC.md를 지키고 기존 변경을 보존해줘.",
    "수정 후 npm run verify를 실행하고 남은 오류·경고 수를 알려줘.",
    "",
    `검증 결과: 오류 ${errorCount}개, 경고 ${warningCount}개`,
    ...issueLines,
  ].join("\n");
}

function storyRoutes(runtime: Runtime) {
  const campaignOrder = new Map(Object.keys(runtime.campaigns).map((id, index) => [id, index]));
  return Object.values(runtime.routes).sort((left, right) => {
    const campaignDelta = (campaignOrder.get(left.campaign_id) ?? 999) - (campaignOrder.get(right.campaign_id) ?? 999);
    if (campaignDelta !== 0) return campaignDelta;
    const campaign = runtime.campaigns[left.campaign_id];
    const laneOrder = new Map(campaign?.lanes.map((lane, index) => [lane.id, index]) || []);
    const leftLane = Object.values(runtime.threads).find((thread) => thread.campaign_id === left.campaign_id && thread.heroine === left.heroine)?.lane;
    const rightLane = Object.values(runtime.threads).find((thread) => thread.campaign_id === right.campaign_id && thread.heroine === right.heroine)?.lane;
    return (laneOrder.get(leftLane || "") ?? 999) - (laneOrder.get(rightLane || "") ?? 999);
  });
}

type ScheduledSceneEntry = {
  sceneId: string;
  eventId: string;
  eventTitle: string;
  slot: string;
  endDay: number;
  priority: number;
};

function scenesByDay(runtime: Runtime): Array<{ day: number; scenes: ScheduledSceneEntry[] }> {
  const totalDays = Math.max(1, ...Object.values(runtime.campaigns).map((campaign) => campaign.total_days));
  const seen = new Set<string>();
  const grouped = new Map<number, ScheduledSceneEntry[]>();
  Object.values(runtime.events)
    .filter((event) => Boolean(event.scene && runtime.scenes[event.scene]))
    .sort((left, right) => {
      const dayDelta = left.window.days[0] - right.window.days[0];
      if (dayDelta !== 0) return dayDelta;
      const campaign = runtime.campaigns[left.campaign_id];
      const slotOrder = new Map((campaign?.slots || []).map((slot, index) => [slot, index]));
      const slotDelta = (slotOrder.get(left.window.slots[0]) ?? 999) - (slotOrder.get(right.window.slots[0]) ?? 999);
      if (slotDelta !== 0) return slotDelta;
      return (left.sequence ?? 999) - (right.sequence ?? 999) || right.priority - left.priority;
    })
    .forEach((event) => {
      const day = event.window.days[0];
      const key = `${day}:${event.scene}`;
      if (!event.scene || seen.has(key)) return;
      seen.add(key);
      const scenes = grouped.get(day) || [];
      scenes.push({
        sceneId: event.scene,
        eventId: event.id,
        eventTitle: event.title,
        slot: event.window.slots.join(" · "),
        endDay: event.window.days[1],
        priority: event.priority,
      });
      grouped.set(day, scenes);
    });
  return Array.from({ length: totalDays }, (_, index) => ({ day: index + 1, scenes: grouped.get(index + 1) || [] }));
}

function sceneSpeakerOptions(runtime: Runtime, scene: Scene): Array<{ id: string; label: string }> {
  const illustrated = scene.cast.map((id) => ({
    id,
    label: runtime.characters[id]?.display_name || id,
  }));
  const supporting = (scene.world_context?.participants || [])
    .filter((id) => runtime.world?.entities[id]?.presentation === "text_only")
    .map((id) => ({ id, label: `${runtime.world?.entities[id]?.display_name || id} · 텍스트 동료` }));
  return [...illustrated, ...supporting].filter((option, index, options) =>
    options.findIndex((candidate) => candidate.id === option.id) === index);
}

function conditionOperators(type: "number" | "enum" | "array") {
  if (type === "number") return [
    ["eq", "같다"], ["ne", "다르다"], ["gt", "초과"], ["gte", "이상"], ["lt", "미만"], ["lte", "이하"],
  ];
  if (type === "array") return [["contains", "포함"], ["not_contains", "미포함"]];
  return [["eq", "같다"], ["ne", "다르다"]];
}

export function ConditionEditor({
  runtime,
  conditions,
  onChange,
  compact = false,
}: {
  runtime: Runtime;
  conditions: Condition[];
  onChange: (conditions: Condition[]) => void;
  compact?: boolean;
}) {
  const paths = useMemo(() => statePaths(runtime), [runtime]);

  const update = (index: number, patch: Partial<Condition>) => {
    const next = clone(conditions);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const add = () => {
    const first = paths[0];
    onChange([...conditions, { path: first.value, op: "gte", value: 0 }]);
  };

  return <div className={compact ? "rule-list compact" : "rule-list"}>
    {conditions.map((condition, index) => {
      const path = paths.find((item) => item.value === condition.path) || paths[0];
      const operators = conditionOperators(path.type);
      return <div className="rule-row" key={`${condition.path}-${index}`}>
        <select
          aria-label="판정 수치"
          value={condition.path}
          onChange={(event) => {
            const selected = paths.find((item) => item.value === event.target.value) || paths[0];
            update(index, {
              path: selected.value,
              op: conditionOperators(selected.type)[0][0],
              value: selected.type === "number" ? 0 : "",
            });
          }}
        >
          {paths.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
        </select>
        <select aria-label="비교 방법" value={condition.op} onChange={(event) => update(index, { op: event.target.value })}>
          {operators.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
        {path.type === "enum" ? <select
          aria-label="비교 값"
          value={String(condition.value || "neutral")}
          onChange={(event) => update(index, { value: event.target.value })}
        >
          {runtime.enums.perceived_state.map((value) => <option value={value} key={value}>{STATE_LABELS[value] || value}</option>)}
        </select> : <input
          aria-label="비교 값"
          type={path.type === "number" ? "number" : "text"}
          value={valueText(condition.value)}
          onChange={(event) => update(index, { value: parseEditorValue(event.target.value, path.type) })}
        />}
        <button type="button" className="icon-button danger" aria-label="조건 삭제" onClick={() => onChange(conditions.filter((_, itemIndex) => itemIndex !== index))}>×</button>
      </div>;
    })}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 조건 추가</button>
  </div>;
}

export function EffectEditor({ runtime, effects, onChange }: { runtime: Runtime; effects: Effect[]; onChange: (effects: Effect[]) => void }) {
  const paths = useMemo(() => statePaths(runtime), [runtime]);

  const update = (index: number, patch: Partial<Effect>) => {
    const next = clone(effects);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const add = () => {
    const first = paths[0];
    onChange([...effects, { path: first.value, op: "add", value: 0 }]);
  };

  return <div className="rule-list">
    {effects.map((effect, index) => {
      const path = paths.find((item) => item.value === effect.path) || paths[0];
      const operations = path.type === "number" ? [["add", "더하기"], ["set", "교체"]]
        : path.type === "array" ? [["append_unique", "항목 추가"], ["remove", "항목 제거"]]
          : [["set", "교체"]];
      return <div className="effect-block" key={`${effect.path}-${index}`}>
        <div className="rule-row">
          <select
            aria-label="변경할 수치"
            value={effect.path}
            onChange={(event) => {
              const selected = paths.find((item) => item.value === event.target.value) || paths[0];
              update(index, {
                path: selected.value,
                op: selected.type === "number" ? "add" : selected.type === "array" ? "append_unique" : "set",
                value: selected.type === "number" ? 0 : "",
              });
            }}
          >
            {paths.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select>
          <select aria-label="변경 방식" value={effect.op} onChange={(event) => update(index, { op: event.target.value })}>
            {operations.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
          {path.type === "enum" ? <select
            aria-label="변경 값"
            value={String(effect.value || "neutral")}
            onChange={(event) => update(index, { value: event.target.value })}
          >
            {runtime.enums.perceived_state.map((value) => <option value={value} key={value}>{STATE_LABELS[value] || value}</option>)}
          </select> : <input
            aria-label="변경 값"
            type={path.type === "number" ? "number" : "text"}
            value={valueText(effect.value)}
            onChange={(event) => update(index, { value: parseEditorValue(event.target.value, path.type) })}
          />}
          <button type="button" className="icon-button danger" aria-label="효과 삭제" onClick={() => onChange(effects.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </div>
        <details className="nested-conditions">
          <summary>이 효과만의 조건 {effect.conditions?.length ? `(${effect.conditions.length})` : ""}</summary>
          <ConditionEditor runtime={runtime} compact conditions={effect.conditions || []} onChange={(conditions) => update(index, { conditions })} />
        </details>
      </div>;
    })}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 수치 효과 추가</button>
  </div>;
}

function LayerEditor({
  title,
  layer,
  mode,
  runtime,
  speaker,
  narration,
  silent,
  lineLocked = false,
  onToggleLineLock,
  onChange,
}: {
  title: string;
  layer: Layer;
  mode: ViewMode;
  runtime: Runtime;
  speaker?: string;
  narration?: boolean;
  silent?: boolean;
  lineLocked?: boolean;
  onToggleLineLock?: () => void;
  onChange: (layer: Layer) => void;
}) {
  const character = speaker ? runtime.characters[speaker] : undefined;
  const expressions = Object.entries(character?.expressions || {}).filter(([, value]) => value.layer === mode);
  const update = (patch: Partial<Layer>) => onChange({ ...layer, ...patch });
  return <fieldset className={`layer-editor ${mode}`}>
    <legend>{title}</legend>
    <div className="form-grid">
      <Field label="분위기">
        <select value={layer.atmosphere || ""} onChange={(event) => update({ atmosphere: event.target.value })}>
          {runtime.enums.atmosphere.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </Field>
      {!narration && <Field label="표정">
        <select value={layer.expression || ""} onChange={(event) => update({ expression: event.target.value })}>
          <option value="">표정 선택</option>
          {expressions.map(([id, value]) => <option value={id} key={id}>{id} · {value.description}</option>)}
        </select>
      </Field>}
      {!silent && mode === "reality" && onToggleLineLock ? <div className="field field-wide"><span className="layer-line-label"><span>속마음 대사</span><button
        type="button"
        className={lineLocked ? "line-lock-button locked" : "line-lock-button"}
        aria-label={lineLocked ? "속마음 대사 잠금 풀기" : "속마음 대사를 원문 대사와 같게 잠그기"}
        title={lineLocked ? "잠금 해제 후 속마음 대사를 다르게 입력" : "원문 대사와 같게 다시 잠금"}
        onClick={onToggleLineLock}
      >{lineLocked ? "🔒" : "🔓"}</button></span><TextArea
        value={layer.line || ""}
        disabled={lineLocked}
        aria-label="속마음 대사"
        onChange={(event) => update({ line: event.target.value })}
      /></div> : !silent && <Field label="화면 대사" wide><TextArea
        value={layer.line || ""}
        aria-label={mode === "perceived" ? "원문 대사" : "속마음 대사"}
        onChange={(event) => update({ line: event.target.value })}
      /></Field>}
      {mode === "reality" && !silent && <Field label="실제 의도">
          <select value={layer.intent || "work_only"} onChange={(event) => update({ intent: event.target.value })}>
            {runtime.enums.intent.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </Field>}
    </div>
  </fieldset>;
}

function ChoiceEditor({ runtime, scene, node, onChange }: { runtime: Runtime; scene: Scene; node: StoryNode; onChange: (node: StoryNode) => void }) {
  const options = node.options || [];
  const updateOption = (index: number, patch: Partial<ChoiceOption>) => {
    const next = clone(options);
    next[index] = { ...next[index], ...patch };
    onChange({ ...node, options: next });
  };
  const updateSupportStyles = (optionIndex: number, supportStyles: SupportStyle[]) => {
    const interaction = options[optionIndex]?.interaction;
    if (!interaction?.target) return;
    updateOption(optionIndex, {
      interaction: { target: interaction.target, support_styles: supportStyles },
    });
  };
  const addSupportStyle = (optionIndex: number) => {
    const interaction = options[optionIndex]?.interaction;
    if (!interaction?.target) return;
    const nextStyle = SUPPORT_STYLE_OPTIONS.find((style) => !interaction.support_styles.includes(style.id));
    if (!nextStyle) return;
    updateSupportStyles(optionIndex, [...interaction.support_styles, nextStyle.id]);
  };
  const moveSupportStyle = (optionIndex: number, styleIndex: number, offset: number) => {
    const styles = options[optionIndex]?.interaction?.support_styles || [];
    const destination = styleIndex + offset;
    if (destination < 0 || destination >= styles.length) return;
    const next = [...styles];
    [next[styleIndex], next[destination]] = [next[destination], next[styleIndex]];
    updateSupportStyles(optionIndex, next);
  };
  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= options.length) return;
    const next = clone(options);
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...node, options: next });
  };
  const add = () => {
    let counter = options.length + 1;
    while (options.some((option) => option.id === `option_${counter}`)) counter += 1;
    onChange({ ...node, options: [...options, {
      id: `option_${counter}`,
      label: "새 선택지",
      interpretation: "",
      action: "",
      push_pull: { action: "literal", intensity: 12, base_score: 4 },
      conditions: [],
      effects: [],
      next: scene.node_order.find((id) => id !== node.id) || "",
    }] });
  };
  return <>
    <Field label="상호작용 맥락">
      <select
        value={node.interaction_context?.kind || ""}
        onChange={(event) => onChange({
          ...node,
          interaction_context: { kind: event.target.value as InteractionContextKind },
        })}
      >
        <option value="" disabled>맥락 선택</option>
        {INTERACTION_CONTEXT_OPTIONS.map((context) => (
          <option value={context.id} key={context.id}>{context.label} · {context.id}</option>
        ))}
      </select>
    </Field>
    <Field label="선택 질문" wide><TextArea value={node.prompt || ""} onChange={(event) => onChange({ ...node, prompt: event.target.value })} /></Field>
    <Field label="대응할 말·행동 요약" wide><TextArea value={node.stimulus || ""} onChange={(event) => onChange({ ...node, stimulus: event.target.value })} /></Field>
    <fieldset className="analysis-hint-editor">
      <legend>심리학 강사 분석 대사</legend>
      <p>이 선택에서만 쓰는 강사 대사입니다. 비워 두면 시스템 대사의 공통 강사 문구를 사용합니다.</p>
      {(["none", "pull", "push"] as const).map((direction) => <Field
        label={direction === "none" ? "첫 방향 대기" : direction === "pull" ? "대화 이어가기" : "말을 줄이고 물러나기"}
        wide
        key={direction}
      ><TextArea
        value={node.analysis_hints?.[direction] || ""}
        onChange={(event) => {
          const next = { ...(node.analysis_hints || {}) };
          if (event.target.value) next[direction] = event.target.value;
          else delete next[direction];
          onChange({ ...node, analysis_hints: Object.keys(next).length ? next : undefined });
        }}
      /></Field>)}
    </fieldset>
    <div className="option-list">
      {options.map((option, index) => <section className="option-editor" key={option.id}>
        <div className="option-heading">
          <strong>선택지 {index + 1}</strong>
          <div className="inline-actions">
            <button type="button" className="icon-button" aria-label="위로" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
            <button type="button" className="icon-button" aria-label="아래로" disabled={index === options.length - 1} onClick={() => move(index, 1)}>↓</button>
            <button type="button" className="icon-button danger" aria-label="선택지 삭제" onClick={() => onChange({ ...node, options: options.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
          </div>
        </div>
        <div className="form-grid">
          <Field label="ID"><TextInput value={option.id} onChange={(event) => updateOption(index, { id: event.target.value })} /></Field>
          <Field label="다음 대사"><select value={option.next} onChange={(event) => updateOption(index, { next: event.target.value })}>{scene.node_order.map((id) => <option value={id} key={id}>{dialogueOptionLabel(scene, id)}</option>)}</select></Field>
          <Field label="플레이어 문구" wide><TextInput value={option.label} onChange={(event) => updateOption(index, { label: event.target.value })} /></Field>
          <Field label="주인공 해석" wide><TextArea value={option.interpretation} onChange={(event) => updateOption(index, { interpretation: event.target.value })} /></Field>
          <Field label="실제로 하는 행동" wide><TextArea value={option.action} onChange={(event) => updateOption(index, { action: event.target.value })} /></Field>
          <Field label="대화 반응 대상">
            <select
              value={option.interaction?.target || ""}
              onChange={(event) => updateOption(index, {
                interaction: event.target.value
                  ? { target: event.target.value, support_styles: option.interaction?.support_styles || [] }
                  : undefined,
              })}
            >
              <option value="">화법 메타데이터 없음</option>
              {Object.values(runtime.characters)
                .filter((character) => scene.cast.includes(character.id))
                .map((character) => <option value={character.id} key={character.id}>{character.display_name}</option>)}
            </select>
          </Field>
          <Field label="지원 화법 순서" wide>
            <div className="rule-list">
              {(option.interaction?.support_styles || []).map((style, styleIndex, supportStyles) => (
                <div className="rule-row" key={`${style}-${styleIndex}`}>
                  <select
                    aria-label={`${styleIndex + 1}번째 지원 화법`}
                    value={style}
                    onChange={(event) => {
                      const next = [...supportStyles];
                      next[styleIndex] = event.target.value as SupportStyle;
                      updateSupportStyles(index, next);
                    }}
                  >
                    {SUPPORT_STYLE_OPTIONS
                      .filter((candidate) => candidate.id === style || !supportStyles.includes(candidate.id))
                      .map((candidate) => (
                        <option value={candidate.id} key={candidate.id}>{candidate.label} · {candidate.id}</option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${styleIndex + 1}번째 지원 화법을 위로`}
                    disabled={styleIndex === 0}
                    onClick={() => moveSupportStyle(index, styleIndex, -1)}
                  >↑</button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${styleIndex + 1}번째 지원 화법을 아래로`}
                    disabled={styleIndex === supportStyles.length - 1}
                    onClick={() => moveSupportStyle(index, styleIndex, 1)}
                  >↓</button>
                  <button
                    type="button"
                    className="icon-button danger"
                    aria-label={`${styleIndex + 1}번째 지원 화법 삭제`}
                    onClick={() => updateSupportStyles(index, supportStyles.filter((_, itemIndex) => itemIndex !== styleIndex))}
                  >×</button>
                </div>
              ))}
              <button
                type="button"
                className="add-row-button"
                disabled={!option.interaction?.target || option.interaction.support_styles.length >= SUPPORT_STYLE_OPTIONS.length}
                onClick={() => addSupportStyle(index)}
              ><IconText>＋</IconText> 지원 화법 추가</button>
            </div>
          </Field>
          <Field label="밀당 계산 대상">
            <select
              value={option.push_pull?.target || ""}
              onChange={(event) => {
                const push_pull = { ...(option.push_pull || { action: "literal" as const, intensity: 12, base_score: 4 }) };
                if (event.target.value) push_pull.target = event.target.value;
                else delete push_pull.target;
                updateOption(index, { push_pull });
              }}
            >
              <option value="">루트 기본 · {runtime.characters[runtime.routes[scene.route]?.heroine]?.display_name || "미지정"}</option>
              {Object.values(runtime.characters)
                .filter((character) => Boolean(runtime.initial_state.visible.heroines[character.id]))
                .map((character) => <option value={character.id} key={character.id}>{character.display_name}</option>)}
            </select>
          </Field>
          <Field label="밀당 방향">
            <select
              value={option.push_pull?.action || "literal"}
              onChange={(event) => updateOption(index, {
                push_pull: {
                  ...(option.push_pull || { intensity: 12, base_score: 4 }),
                  action: event.target.value as ChoiceOption["push_pull"]["action"],
                },
              })}
            >
              <option value="approach">당기기 · 접근 시도</option>
              <option value="space">밀기 · 거리 둠</option>
              <option value="literal">문자 그대로 따름</option>
            </select>
          </Field>
          <Field label="이동 강도 (8~16)">
            <TextInput
              type="number"
              min="8"
              max="16"
              value={option.push_pull?.intensity ?? 12}
              onChange={(event) => updateOption(index, {
                push_pull: {
                  ...(option.push_pull || { action: "literal", base_score: 4 }),
                  intensity: Number(event.target.value),
                },
              })}
            />
          </Field>
          <Field label="기본 점수 (2~5)">
            <TextInput
              type="number"
              min="2"
              max="5"
              value={option.push_pull?.base_score ?? 4}
              onChange={(event) => updateOption(index, {
                push_pull: {
                  ...(option.push_pull || { action: "literal", intensity: 12 }),
                  base_score: Number(event.target.value),
                },
              })}
            />
          </Field>
        </div>
        <details>
          <summary>표시 조건 ({option.conditions.length})</summary>
          <ConditionEditor runtime={runtime} conditions={option.conditions} onChange={(conditions) => updateOption(index, { conditions })} />
        </details>
        <details open>
          <summary>수치 효과 ({option.effects.length})</summary>
          <EffectEditor runtime={runtime} effects={option.effects} onChange={(effects) => updateOption(index, { effects })} />
        </details>
      </section>)}
    </div>
    <button type="button" className="add-card-button" onClick={add}><IconText>＋</IconText> 선택지 추가</button>
  </>;
}

function TransitionEditor({
  runtime,
  scene,
  transitions,
  target,
  onChange,
}: {
  runtime: Runtime;
  scene: Scene;
  transitions: Transition[];
  target: "node" | "scene";
  onChange: (transitions: Transition[]) => void;
}) {
  const update = (index: number, patch: Partial<Transition>) => {
    const next = clone(transitions);
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };
  const move = (index: number, offset: number) => {
    const destination = index + offset;
    if (destination < 0 || destination >= transitions.length || transitions[destination].default) return;
    const next = clone(transitions);
    [next[index], next[destination]] = [next[destination], next[index]];
    onChange(next);
  };
  const add = () => {
    const defaultIndex = transitions.findIndex((transition) => transition.default);
    const entry: Transition = { conditions: [], [target]: target === "node" ? scene.node_order[0] : scene.id };
    const next = clone(transitions);
    next.splice(defaultIndex >= 0 ? defaultIndex : next.length, 0, entry);
    if (!next.some((transition) => transition.default)) next.push({ default: true, [target]: target === "node" ? scene.node_order[0] : scene.id });
    onChange(next);
  };
  const destinations = target === "node" ? scene.node_order : Object.keys(runtime.scenes);

  return <div className="transition-list">
    {transitions.map((transition, index) => <section className={transition.default ? "transition-row default" : "transition-row"} key={index}>
      <div className="transition-heading">
        <strong>{transition.default ? "기본 분기" : `${index + 1}순위 분기`}</strong>
        {!transition.default && <div className="inline-actions">
          <button type="button" className="icon-button" aria-label="분기를 위로" disabled={index === 0} onClick={() => move(index, -1)}>↑</button>
          <button type="button" className="icon-button" aria-label="분기를 아래로" disabled={index + 1 >= transitions.length || transitions[index + 1].default} onClick={() => move(index, 1)}>↓</button>
          <button type="button" className="icon-button danger" aria-label="분기 삭제" onClick={() => onChange(transitions.filter((_, itemIndex) => itemIndex !== index))}>×</button>
        </div>}
      </div>
      {!transition.default && <ConditionEditor runtime={runtime} compact conditions={transition.conditions || []} onChange={(conditions) => update(index, { conditions })} />}
      {target === "scene" && <Field label="목적지 종류">
        <select
          value={transition.ending ? "ending" : "scene"}
          onChange={(event) => update(index, event.target.value === "ending"
            ? { ending: true, ending_id: transition.ending_id || "draft.ending", scene: undefined }
            : { ending: undefined, ending_id: undefined, scene: scene.id })}
        >
          <option value="scene">다른 장면</option>
          <option value="ending">엔딩 완료</option>
        </select>
      </Field>}
      {transition.ending ? <Field label="엔딩 ID"><TextInput value={transition.ending_id || ""} onChange={(event) => update(index, { ending_id: event.target.value })} /></Field>
        : <Field label={target === "node" ? "이동할 대사" : "이동할 장면"}>
          <select value={String(transition[target] || "")} onChange={(event) => update(index, { [target]: event.target.value })}>
          {destinations.map((id) => <option value={id} key={id}>{target === "scene" ? `${runtime.scenes[id]?.title || id}` : dialogueOptionLabel(scene, id)}</option>)}
          </select>
        </Field>}
    </section>)}
    <button type="button" className="add-row-button" onClick={add}><IconText>＋</IconText> 조건 분기 추가</button>
  </div>;
}

function DialogueVariantEditor({
  runtime,
  state,
  node,
  onChange,
}: {
  runtime: Runtime;
  state: RuntimeState;
  node: StoryNode;
  onChange: (node: StoryNode) => void;
}) {
  const variants = node.variants || [];
  const selectedVariantId = node.variants ? resolveDialogueNode(runtime, state, node).variantId : undefined;
  const [focusedVariantId, setFocusedVariantId] = useState("");
  const materializedSelfDevelopment = variants.some((variant) => Boolean(variant.self_development));
  const orderedVariants = variants
    .map((variant, index) => ({ variant, index }))
    .sort((left, right) =>
      Number(left.variant.default) - Number(right.variant.default)
      || (right.variant.priority || 0) - (left.variant.priority || 0)
      || left.index - right.index);
  const activeMaterializedId = variants.some((variant) => variant.id === focusedVariantId)
    ? focusedVariantId
    : selectedVariantId || orderedVariants[0]?.variant.id;
  const displayedVariants = materializedSelfDevelopment
    ? orderedVariants.filter(({ variant }) => variant.id === activeMaterializedId)
    : orderedVariants;
  const narration = node.kind === "dual_narration";
  const duplicateConditionIds = new Set<string>();
  variants.forEach((variant, index) => {
    if (variant.default || variant.self_development) return;
    const signature = JSON.stringify(variant.conditions || []);
    if (variants.some((candidate, candidateIndex) =>
      candidateIndex < index && !candidate.default && !candidate.self_development && JSON.stringify(candidate.conditions || []) === signature)) {
      duplicateConditionIds.add(variant.id);
    }
  });

  const update = (index: number, patch: Partial<DialogueVariant>) => {
    const next = clone(variants);
    next[index] = { ...next[index], ...patch };
    onChange({ ...node, variants: next });
  };
  const startVariants = () => {
    const defaultVariant: DialogueVariant = {
      id: "default",
      priority: 0,
      default: true,
      perceived: clone(node.perceived || {}),
      reality: clone(node.reality || {}),
    };
    const next = { ...node, variants: [defaultVariant] };
    delete next.perceived;
    delete next.reality;
    onChange(next);
  };
  const flattenVariants = () => {
    const source = variants.find((variant) => variant.default) || variants[0];
    if (!source) return;
    const next = {
      ...node,
      perceived: clone(source.perceived),
      reality: clone(source.reality),
    };
    delete next.variants;
    onChange(next);
  };
  const add = () => {
    let counter = variants.length + 1;
    while (variants.some((variant) => variant.id === `variant_${counter}`)) counter += 1;
    const source = variants.find((variant) => variant.default) || variants[0];
    const next: DialogueVariant = {
      id: `variant_${counter}`,
      priority: Math.max(10, ...variants.map((variant) => variant.priority || 0)) + 10,
      conditions: [],
      perceived: clone(source?.perceived || {}),
      reality: clone(source?.reality || {}),
    };
    onChange({ ...node, variants: [...variants.filter((variant) => !variant.default), next, ...variants.filter((variant) => variant.default)] });
  };
  const cloneVariant = (index: number) => {
    let counter = 2;
    const base = variants[index].id.replace(/[._]?copy\d*$/, "");
    while (variants.some((variant) => variant.id === `${base}.copy${counter}`)) counter += 1;
    const copy = clone(variants[index]);
    copy.id = `${base}.copy${counter}`;
    copy.default = undefined;
    copy.priority = (copy.priority || 0) + 1;
    copy.conditions ||= [];
    const next = clone(variants);
    next.splice(index + 1, 0, copy);
    onChange({ ...node, variants: next });
  };
  const makeDefault = (index: number) => {
    if (variants[index]?.self_development) return;
    onChange({
      ...node,
      variants: variants.map((variant, itemIndex) => ({
        ...variant,
        default: itemIndex === index ? true : undefined,
        conditions: itemIndex === index ? undefined : variant.conditions || [],
      })),
    });
  };

  if (!node.variants) {
    return <section className="variant-authoring-intro">
      <div><strong>상황별 대사 변형</strong><small>현재 대사를 기본 변형으로 바꾼 뒤 조건별 문구를 추가합니다.</small></div>
      <button type="button" onClick={startVariants}>변형 사용</button>
    </section>;
  }

  return <section className="dialogue-variant-editor">
    <header>
      <div><strong>{materializedSelfDevelopment ? "직전 밤 활동별 대사" : "상황별 대사 변형"}</strong><small>{materializedSelfDevelopment ? "플레이어가 전날 선택한 활동에 따라 실제로 표시되는 완성 대사입니다." : "우선순위가 높은 조건을 먼저 검사하며, 기본 변형은 항상 마지막 대체값입니다."}</small></div>
      {!materializedSelfDevelopment && <div className="inline-actions">
        <button type="button" onClick={add}>＋ 변형 추가</button>
        <button type="button" onClick={flattenVariants}>기본 대사로 합치기</button>
      </div>}
    </header>
    {materializedSelfDevelopment && <nav className="self-development-variant-picker" aria-label="직전 밤 활동별 대사">
      {orderedVariants.map(({ variant }) => <button
        type="button"
        className={variant.id === activeMaterializedId ? "active" : ""}
        onClick={() => setFocusedVariantId(variant.id)}
        key={variant.id}
      ><span>{selfDevelopmentVariantDisplayName(variant.id)}</span>{variant.id === selectedVariantId && <small>현재 미리보기</small>}</button>)}
    </nav>}
    <div className="dialogue-variant-list">
      {displayedVariants.map(({ variant, index }) => {
        const invalidId = !/^[a-z][a-z0-9_.]*$/.test(variant.id)
          || variants.some((candidate, candidateIndex) => candidateIndex !== index && candidate.id === variant.id);
        const selfDevelopmentVariant = Boolean(variant.self_development);
        return <article className={`dialogue-variant-card ${variant.default ? "default" : ""} ${variant.id === selectedVariantId ? "selected" : ""}`} key={`${variant.id}:${index}`}>
          <div className="dialogue-variant-heading">
            {materializedSelfDevelopment ? <div className="materialized-variant-title">
              <strong>{selfDevelopmentVariantDisplayName(variant.id)}</strong>
              <small>{variant.default ? "앞선 밤 활동 기록이 없거나 일치하지 않을 때 표시됩니다." : `${selfDevelopmentVariantDisplayName(variant.id)}을 선택한 다음 날 표시됩니다.`}</small>
              <details><summary>고급 정보 · 안정 ID와 우선순위</summary><div className="dialogue-variant-fields">
                <Field label="안정 ID"><TextInput value={variant.id} readOnly /></Field>
                <Field label="우선순위"><TextInput type="number" value={variant.priority || 0} readOnly /></Field>
              </div></details>
            </div> : <div className="dialogue-variant-fields">
              <Field label="안정 ID"><TextInput value={variant.id} aria-invalid={invalidId} onChange={(event) => update(index, { id: event.target.value })} /></Field>
              <Field label="우선순위"><TextInput type="number" value={variant.priority || 0} onChange={(event) => update(index, { priority: Number(event.target.value) })} /></Field>
            </div>}
            {!materializedSelfDevelopment && <div className="inline-actions">
              {!variant.default && <button
                type="button"
                disabled={selfDevelopmentVariant}
                title={selfDevelopmentVariant ? "자기계발 변형은 기본값으로 지정할 수 없습니다." : undefined}
                onClick={() => makeDefault(index)}
              >기본값 지정</button>}
              <button type="button" onClick={() => cloneVariant(index)}>복제</button>
              <button type="button" className="icon-button danger" aria-label="변형 삭제" disabled={variant.default} onClick={() => onChange({ ...node, variants: variants.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
            </div>}
          </div>
          {materializedSelfDevelopment
            ? <p className="variant-default-note">{variant.default ? "기본 대사" : "자동 조건"} · 이 탭에서는 완성 대사와 연출만 편집합니다.</p>
            : variant.default
            ? <p className="variant-default-note">기본 변형 · 다른 조건이 모두 실패할 때 사용됩니다.</p>
            : <ConditionEditor runtime={runtime} conditions={variant.conditions || []} onChange={(conditions) => update(index, { conditions })} />}
          {(invalidId || duplicateConditionIds.has(variant.id)) && <p className="variant-warning">
            {invalidId ? "ID는 소문자 영문으로 시작하며 중복될 수 없습니다." : "앞선 변형과 조건이 같아 이 변형은 도달하지 못할 수 있습니다."}
          </p>}
          <div className="dual-layer-grid">
            <LayerEditor
              title={narration ? "주인공이 보는 서술" : "주인공이 보는 장면"}
              narration={narration}
              layer={variant.perceived}
              mode="perceived"
              runtime={runtime}
              speaker={effectiveSpeaker(node, "perceived")}
              onChange={(perceived) => update(index, { perceived })}
            />
            <LayerEditor
              title={narration ? "실제 서술" : "실제 장면"}
              narration={narration}
              layer={variant.reality}
              mode="reality"
              runtime={runtime}
              speaker={effectiveSpeaker(node, "reality")}
              onChange={(reality) => update(index, { reality })}
            />
          </div>
        </article>;
      })}
    </div>
  </section>;
}

function NodeEditor({
  root,
  runtime,
  state,
  scene,
  node,
  mode,
  onMode,
  onChange,
}: {
  root: string;
  runtime: Runtime;
  state: RuntimeState;
  scene: Scene;
  node: StoryNode;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  onChange: (node: StoryNode) => void;
}) {
  const commonNext = node.kind === "dual_dialogue" || node.kind === "dual_narration" || node.kind === "silent" || node.kind === "effect";
  const speakerOptions = sceneSpeakerOptions(runtime, scene);
  const lineLayersLocked = node.line_layers_locked === true;
  const updatePerceivedLayer = (perceived: Layer) => onChange({
    ...node,
    perceived,
    ...(lineLayersLocked ? { reality: { ...node.reality, line: perceived.line || "" } } : {}),
  });
  const toggleLineLayersLock = () => onChange(lineLayersLocked
    ? { ...node, line_layers_locked: false }
    : {
      ...node,
      line_layers_locked: true,
      reality: { ...node.reality, line: node.perceived?.line || "" },
    });
  return <div className="node-editor">
    <ArtworkStageEditor root={root} runtime={runtime} scene={scene} node={node} mode={mode} onMode={onMode} onChange={onChange} />
    <div className="form-grid compact-grid">
      <Field label="대사 종류"><select value={node.kind} disabled>{Object.entries(NODE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
      {commonNext && <Field label="다음 대사"><select value={node.next || ""} onChange={(event) => onChange({ ...node, next: event.target.value })}><option value="">선택</option>{scene.node_order.filter((id) => id !== node.id).map((id) => <option value={id} key={id}>{dialogueOptionLabel(scene, id)}</option>)}</select></Field>}
      {(node.kind === "dual_dialogue" || node.kind === "dual_narration") && <Field label="연출 플래그"><TextInput placeholder="ui_glitch, original_text_lock, auditory_distortion" value={(node.presentation_flags || []).join(", ")} onChange={(event) => onChange({ ...node, presentation_flags: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></Field>}
    </div>

    {node.kind === "dual_dialogue" && <>
      {node.presentation_flags?.includes("inner_voice") ? <div className="form-grid compact-grid">
        {(["perceived", "reality"] as ViewMode[]).map((mode) => <Field label={mode === "perceived" ? "스토리 모드 생각 화자" : "속마음 모드 생각 화자"} key={mode}><select value={node.speakers?.[mode] || ""} onChange={(event) => onChange({ ...node, speakers: { ...node.speakers, [mode]: event.target.value || null } })}><option value="">화자 없는 서술</option>{speakerOptions.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}</select></Field>)}
      </div> : <Field label="화자"><select value={node.speaker || ""} onChange={(event) => onChange(applyDialogueSpeakerSelection(runtime, node, event.target.value))}><option value="">화자 선택</option>{speakerOptions.map(({ id, label }) => <option value={id} key={id}>{label}</option>)}</select></Field>}
      {!node.variants && <div className="dual-layer-grid">
        <LayerEditor title="주인공이 보는 장면" layer={node.perceived || {}} mode="perceived" runtime={runtime} speaker={effectiveSpeaker(node, "perceived")} onChange={updatePerceivedLayer} />
        <LayerEditor title="실제 장면" layer={node.reality || {}} mode="reality" runtime={runtime} speaker={effectiveSpeaker(node, "reality")} lineLocked={lineLayersLocked} onToggleLineLock={toggleLineLayersLock} onChange={(reality) => onChange({ ...node, reality })} />
      </div>}
      <DialogueVariantEditor runtime={runtime} state={state} node={node} onChange={onChange} />
    </>}

    {node.kind === "dual_narration" && <>
      {!node.variants && <div className="dual-layer-grid">
        <LayerEditor title="주인공이 보는 서술" narration layer={node.perceived || {}} mode="perceived" runtime={runtime} onChange={updatePerceivedLayer} />
        <LayerEditor title="실제 서술" narration layer={node.reality || {}} mode="reality" runtime={runtime} lineLocked={lineLayersLocked} onToggleLineLock={toggleLineLayersLock} onChange={(reality) => onChange({ ...node, reality })} />
      </div>}
      <DialogueVariantEditor runtime={runtime} state={state} node={node} onChange={onChange} />
    </>}

    {node.kind === "silent" && <>
      <p className="silent-node-help">게임에서는 대사창을 숨기고 배경과 배치한 원화만 보여 줍니다. 화면을 클릭하면 다음 대사로 이동합니다.</p>
      <div className="dual-layer-grid">
        <LayerEditor title="스토리 모드 화면 분위기" narration silent layer={node.perceived || {}} mode="perceived" runtime={runtime} onChange={(perceived) => onChange({ ...node, perceived: { ...perceived, line: "" } })} />
        <LayerEditor title="속마음 모드 화면 분위기" narration silent layer={node.reality || {}} mode="reality" runtime={runtime} onChange={(reality) => onChange({ ...node, reality: { ...reality, line: "" } })} />
      </div>
    </>}

    {node.kind === "choice" && <ChoiceEditor runtime={runtime} scene={scene} node={node} onChange={onChange} />}
    {node.kind === "state_gate" && <TransitionEditor runtime={runtime} scene={scene} transitions={node.transitions || []} target="node" onChange={(transitions) => onChange({ ...node, transitions })} />}
    {node.kind === "effect" && <EffectEditor runtime={runtime} effects={node.effects || []} onChange={(effects) => onChange({ ...node, effects })} />}
    {node.kind === "exit" && <TransitionEditor runtime={runtime} scene={scene} transitions={node.transitions || []} target="scene" onChange={(transitions) => onChange({ ...node, transitions })} />}
  </div>;
}

function StateSlider({ label, value, min = 0, max = 100, onChange }: { label: string; value: number; min?: number; max?: number; onChange: (value: number) => void }) {
  return <label className="state-slider"><span>{label}<output>{value}</output></span><input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function Preview({
  runtime,
  scene,
  selectedNodeId,
  mode,
  onMode,
  state,
  initialState,
  onState,
  image,
}: {
  runtime: Runtime;
  scene: Scene;
  selectedNodeId: string;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  state: RuntimeState;
  initialState: RuntimeState;
  onState: (state: RuntimeState) => void;
  image?: string;
}) {
  const route = runtime.routes[scene.route];
  const baseHeroine = route.heroine;
  const rhythmState = readPushPullState(state);
  const heroine = rhythmState.heroine && state.visible.heroines[rhythmState.heroine]
    ? rhythmState.heroine
    : baseHeroine;
  const visible = state.visible.heroines[heroine];
  const hidden = state.hidden.heroines[heroine];
  const [pushPullResult, setPushPullResult] = useState<PushPullResult | null>(null);
  const emotion = deriveEmotion(runtime.characters[heroine], hidden);
  const selected = scene.nodes[selectedNodeId];
  const automatic = selected?.kind === "state_gate" ? chooseTransition(state, selected.transitions) : undefined;
  const rawDisplayNode = automatic?.chosen?.node ? scene.nodes[automatic.chosen.node] : selected;
  const dialogueResolution = rawDisplayNode && (rawDisplayNode.kind === "dual_dialogue" || rawDisplayNode.kind === "dual_narration")
    ? resolveDialogueNode(runtime, state, rawDisplayNode)
    : undefined;
  const displayNode = dialogueResolution?.node || rawDisplayNode;
  const layer = displayNode?.[mode] as Layer | undefined;
  const exitDecision = displayNode?.kind === "exit" ? chooseTransition(state, displayNode.transitions) : undefined;
  const availableOptions = displayNode?.kind === "choice" ? (displayNode.options || []).filter((option) =>
    conditionsMatch(state, option.conditions)
      && (!option.self_development
        || selfDevelopmentSystem(runtime).eligibility.isEligible(state, option.self_development.expression))) : [];
  const hasClearedEnding = state.progress.cleared_routes.length > 0;
  const entryDecision = canEnterScene(runtime, state, scene.id);

  useEffect(() => {
    setPushPullResult(null);
  }, [scene.id, heroine]);

  useEffect(() => {
    if (!pushPullResult) return;
    const timer = window.setTimeout(() => setPushPullResult(null), 1400);
    return () => window.clearTimeout(timer);
  }, [pushPullResult]);

  const updateHeroine = (section: "visible" | "hidden", key: string, value: number | string) => {
    const next = clone(state);
    if (section === "visible") (next.visible.heroines[heroine] as unknown as Record<string, number | string>)[key] = value;
    else (next.hidden.heroines[heroine] as unknown as Record<string, number>)[key] = Number(value);
    onState(next);
  };

  const simulateChoice = (option: ChoiceOption) => {
    const next = clone(state);
    const visibleScoreBonus = option.self_development
      ? selfDevelopmentSystem(runtime).eligibility.scoreBonus(state, option.self_development.expression)
      : 0;
    option.effects.forEach((effect) => applyEffect(runtime, next, effect));
    const result = resolvePushPull(next, option.push_pull?.target || baseHeroine, option.push_pull, { visibleScoreBonus });
    setPushPullResult(result);
    onState(next);
  };

  const updateRhythm = (patch: { position?: number; combo?: number; target?: PushPullTarget }) => {
    const next = clone(state);
    writePushPullState(next, { ...readPushPullState(next), ...patch, heroine });
    setPushPullResult(null);
    onState(next);
  };

  const speaker = effectiveSpeaker(displayNode, mode);
  const character = speaker ? runtime.characters[speaker] : undefined;
  const showPreviewImage = Boolean(character && speaker === heroine && image);
  const expression = layer?.expression || emotion?.default_expression || "narration";
  const truthLabels = mode === "reality" || hasClearedEnding;
  const rhythmLabelMode: ViewMode = truthLabels ? "reality" : "perceived";
  const scoreLabel = truthLabels ? "통제 욕구" : "밀당 주도권";
  const comboLabel = truthLabels ? "통제 시도 연쇄" : "COMBO";
  const markerPosition = `${(rhythmState.position + 100) / 2}%`;
  const targetPosition = rhythmState.target === "pull" ? "34%" : rhythmState.target === "push" ? "66%" : "50%";
  const rhythmStyle = {
    "--rhythm-marker": markerPosition,
    "--rhythm-target": targetPosition,
  } as CSSProperties;

  return <aside className="preview-panel">
    <div className="panel-heading">
      <div><p className="eyebrow">LIVE PREVIEW</p><h2>게임 화면</h2></div>
      <div className="segmented"><button type="button" className={mode === "perceived" ? "active" : ""} onClick={() => onMode("perceived")}>스토리 모드</button><button type="button" className={mode === "reality" ? "active truth" : ""} onClick={() => onMode("reality")}>실제</button></div>
    </div>

    <div className={`mini-game ${mode}`}>
      <div className="mini-portrait">
        {showPreviewImage ? <img src={image} alt={`${character?.display_name || speaker} 콘셉트 아트`} /> : <div className="image-placeholder">{speaker ? "ACTIVE SPEAKER" : "NO SPEAKER"}</div>}
        {character && <div className="portrait-label"><strong>{character.display_name}</strong><span>{expression}</span></div>}
      </div>
        {displayNode?.kind !== "silent" && <div className="mini-dialogue">
        <div className="push-pull-hud">
          <div className="push-pull-score">
            <span>{scoreLabel}</span>
            <strong>{visible.initiative}</strong>
            {rhythmState.combo > 0 && <em>{comboLabel} x{rhythmState.combo}</em>}
          </div>
          <div
            className={`rhythm-gauge ${rhythmState.target === "none" ? "no-target" : ""}`}
            style={rhythmStyle}
            role="img"
            aria-label={`현재 ${pushPullPositionLabel(rhythmState.position, rhythmLabelMode)}, 다음 득점선 ${pushPullTargetLabel(rhythmState.target, rhythmLabelMode)}`}
          >
            <span>{rhythmLabelMode === "perceived" ? "당기기" : "접근 시도"}</span>
            <div aria-hidden="true">
              <i className="optimal-range"></i>
              <i className="checkpoint pull"></i>
              <i className="checkpoint push"></i>
              <i className="active-target"></i>
              <b className="rhythm-marker"></b>
            </div>
            <span>{rhythmLabelMode === "perceived" ? "밀기" : "거리 둠"}</span>
            <small>현재: {pushPullPositionLabel(rhythmState.position, rhythmLabelMode)}</small>
            <small>다음 득점선: {pushPullTargetLabel(rhythmState.target, rhythmLabelMode)}</small>
          </div>
        </div>
        <div className="dialogue-copy">
          <small>{layer?.atmosphere || NODE_LABELS[displayNode?.kind || "effect"]}</small>
          <blockquote>{layer?.line || (displayNode?.kind === "choice" ? displayNode.prompt : displayNode?.kind === "exit" ? "장면을 떠납니다." : "판정 노드")}</blockquote>
          {mode === "reality" && layer?.intent && <p>{layer.intent}</p>}
        </div>
      </div>}
    </div>

    <div className={`preview-runtime-trace ${entryDecision.allowed ? "allowed" : "blocked"}`}>
      <strong>{entryDecision.allowed ? "장면 진입 가능" : "장면 진입 차단"}</strong>
      <small>{entryDecision.trace.length
        ? entryDecision.trace.map((item) => `${item.met ? "✓" : "×"} ${item.condition.path} ${item.condition.op} ${String(item.condition.value)} (현재 ${String(item.actual)})`).join(" / ")
        : "진입 조건 없음"}</small>
    </div>

    {dialogueResolution && <div className="preview-runtime-trace variant">
      <strong>선택된 대사 · {dialogueResolution.variantId}</strong>
      <small>{dialogueResolution.trace.map((item) => `${item.chosen ? "●" : item.met ? "○" : "×"} ${item.variantId} (우선순위 ${item.priority})`).join(" / ")}</small>
    </div>}

    {pushPullResult && <div className={`push-pull-feedback ${pushPullResult.kind}`} aria-live="polite">
      <strong>{truthLabels
        ? pushPullResult.kind === "literal" ? "반복 중단" : pushPullResult.combo >= 5 ? "대응·기록 연결" : "반복 패턴 확인"
        : pushPullResult.kind === "turn" ? "적정선 도착"
          : pushPullResult.kind === "score" ? "밀당의 흐름을 잡았다"
            : pushPullResult.kind === "literal" ? "흐름을 잠시 놓쳤다"
              : "득점 없음"}</strong>
      <span>{pushPullResult.gain > 0 ? `+${pushPullResult.gain}` : `${scoreLabel} 변화 없음`}</span>
      <small>{pushPullResult.kind === "turn"
        ? `다음 득점선: ${pushPullTargetLabel(pushPullResult.target, rhythmLabelMode)}`
        : pushPullResult.combo > 0 ? `${comboLabel} x${pushPullResult.combo}` : pushPullPositionLabel(pushPullResult.position, rhythmLabelMode)}</small>
    </div>}

    {availableOptions.length > 0 && <div className="preview-choices">{availableOptions.map((option) => <button type="button" key={option.id} onClick={() => simulateChoice(option)}><strong>{option.label}</strong><small>{option.action}</small></button>)}</div>}

    <div className="test-state">
      <div className="state-section-heading"><div className="state-section-label">테스트 상태 · {runtime.characters[heroine].display_name}</div><button type="button" onClick={() => { setPushPullResult(null); onState(clone(initialState)); }}>수치 초기화</button></div>
      <StateSlider label={scoreLabel} value={visible.initiative} onChange={(value) => updateHeroine("visible", "initiative", value)} />
      <StateSlider label="리듬 위치" value={rhythmState.position} min={-100} onChange={(value) => updateRhythm({ position: value })} />
      <StateSlider label="콤보" value={rhythmState.combo} max={5} onChange={(value) => updateRhythm({ combo: value })} />
      <label className="state-select"><span>활성 득점선</span><select value={rhythmState.target} onChange={(event) => updateRhythm({ target: event.target.value as PushPullTarget })}><option value="pull">당기기</option><option value="push">밀기</option><option value="none">첫 방향 대기</option></select></label>
      <StateSlider label="의심도" value={hidden.suspicion} onChange={(value) => updateHeroine("hidden", "suspicion", value)} />
      <StateSlider label="비호감" value={hidden.dislike} onChange={(value) => updateHeroine("hidden", "dislike", value)} />
      <StateSlider label="물리적 증거" value={hidden.evidence_count} max={10} onChange={(value) => updateHeroine("hidden", "evidence_count", value)} />
      <div className="emotion-chip"><strong>{emotion?.emotion || "미정"}</strong><span>{emotion?.behavior || "행동 규칙 없음"}</span></div>
    </div>

    {(automatic || exitDecision) && <DecisionPanel trace={(automatic || exitDecision)!.trace} state={state} />}
  </aside>;
}

function DecisionPanel({ trace, state }: { trace: DecisionTrace[]; state: RuntimeState }) {
  return <div className="decision-panel"><strong>현재 분기 판정</strong>{trace.map((item, index) => <div className={item.chosen ? "decision chosen" : "decision"} key={index}>
    <span>{item.chosen ? "●" : item.met ? "○" : "×"} {item.transition.default ? "기본 분기" : `${index + 1}순위`}</span>
    <small>{item.transition.node || item.transition.scene || item.transition.ending_id || "목적지 없음"}</small>
    {!item.transition.default && <em>{(item.transition.conditions || []).map((condition) => `${condition.path.split(".").pop()} ${condition.op} ${String(condition.value)} (현재 ${String(getPath(state, condition.path))})`).join(" / ")}</em>}
  </div>)}</div>;
}

export default function App() {
  useSaveCommandBinding();
  const bootStarted = useRef(false);
  const recoveredJournalKeys = useRef(new Set<string>());
  const [payload, setPayload] = useState<ProjectPayload | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [draft, setDraftState] = useState<Scene | null>(null);
  const draftRef = useRef<Scene | null>(null);
  const dirtyRef = useRef(false);
  const historyGroupRef = useRef<EditHistoryGroup | null>(null);
  const draftVersionRef = useRef(0);
  const [revision, setRevision] = useState("");
  const [dirty, setDirty] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });
  const [mode, setMode] = useState<ViewMode>("perceived");
  const [testState, setTestState] = useState<RuntimeState | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState("에디터 준비 중…");
  const [busy, setBusy] = useState(false);
  const [editorTab, setEditorTab] = useState<"scene" | "node" | "source">("node");
  const [newNodeKind, setNewNodeKind] = useState<NodeKind>("dual_dialogue");
  const [dialogueSearch, setDialogueSearch] = useState("");
  const [dialogueClipboard, setDialogueClipboard] = useState<DialogueClipboard | null>(null);
  const [dialogueContextMenu, setDialogueContextMenu] = useState<DialogueContextMenuState | null>(null);
  const [storyFlowCollapsed, setStoryFlowCollapsed] = useState(initialStoryFlowCollapsed);
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Workspace[]>(() => [initialWorkspace()]);
  const [locale, setLocale] = useState("ko");
  const [documentActivity, setDocumentActivity] = useState<DocumentActivity>({ phase: "saved", label: "프로젝트", path: "" });
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [timelineRequest, setTimelineRequest] = useState<{ id: string; token: number } | null>(null);
  const [characterRequest, setCharacterRequest] = useState<{ id: string; token: number } | null>(null);
  const [settingsRequest, setSettingsRequest] = useState<SettingsRequest | null>(null);
  const [duplicateRequest, setDuplicateRequest] = useState<{ kind: "scene" | "event"; id: string; title: string } | null>(null);
  const workspaceRef = useRef<Workspace>(workspace);
  const [workspaceActivities, setWorkspaceActivities] = useState<Partial<Record<Workspace, DocumentActivity>>>({});

  useEffect(() => {
    workspaceRef.current = workspace;
    setVisitedWorkspaces((current) => current.includes(workspace) ? current : [...current, workspace]);
    try { localStorage.setItem("love-office:last-workspace", workspace); } catch { /* WebView storage can be unavailable in restricted sessions. */ }
  }, [workspace]);

  useEffect(() => {
    try { localStorage.setItem("love-office:story-flow-collapsed", String(storyFlowCollapsed)); } catch { /* WebView storage can be unavailable in restricted sessions. */ }
  }, [storyFlowCollapsed]);

  const reportActivity = useCallback((source: Workspace, activity: DocumentActivity) => {
    setWorkspaceActivities((current) => ({ ...current, [source]: activity }));
    if (workspaceRef.current === source) setDocumentActivity(activity);
  }, []);
  const reportSceneActivity = useCallback((activity: DocumentActivity) => reportActivity("scene", activity), [reportActivity]);
  const reportSystemActivity = useCallback((activity: DocumentActivity) => reportActivity("system", activity), [reportActivity]);
  const reportTimelineActivity = useCallback((activity: DocumentActivity) => reportActivity("timeline", activity), [reportActivity]);
  const reportCharacterActivity = useCallback((activity: DocumentActivity) => reportActivity("character", activity), [reportActivity]);
  const reportPresentationActivity = useCallback((activity: DocumentActivity) => reportActivity("presentation", activity), [reportActivity]);
  const reportSettingsActivity = useCallback((activity: DocumentActivity) => reportActivity("settings", activity), [reportActivity]);

  const replaceDraft = useCallback((next: Scene | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const setSceneDirty = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const runtime = payload?.runtime;
  const root = payload?.root;
  const currentRoute = draft && runtime ? runtime.routes[draft.route] : undefined;
  const heroineId = currentRoute?.heroine;
  const selectedNode = draft?.nodes[selectedNodeId];
  const selectDialogueNode = useCallback((id: string) => setSelectedNodeId(id), []);
  const visibleDialogueIds = useMemo(() => {
    if (!draft) return [];
    const query = dialogueSearch.trim().toLocaleLowerCase();
    return draft.node_order.filter((id) => {
      return !query || nodeScreenTexts(draft.nodes[id]).some((text) => text.toLocaleLowerCase().includes(query));
    });
  }, [dialogueSearch, draft]);
  const dialogueOrder = useMemo(() => new Map(draft?.node_order.map((id, index) => [id, index]) || []), [draft?.node_order]);
  const sceneDayGroups = useMemo(() => runtime ? scenesByDay(runtime) : [], [runtime]);
  const contract = useMemo(() => {
    if (!draft) return { reads: [], writes: [] };
    if (editorTab !== "scene") return draft.state_contract || { reads: [], writes: [] };
    return deriveStateContract(draft, heroineId, runtime);
  }, [draft, editorTab, heroineId, runtime]);

  const loadScene = useCallback((project: ProjectPayload, sceneId: string, force = false) => {
    if (!force && dirty && !window.confirm("저장하지 않은 변경을 버리고 다른 장면을 열까요?")) return;
    const sourceScene = project.runtime.scenes[sceneId];
    if (!sourceScene) return;
    let next = clone(sourceScene);
    let recoveredDraft = false;
    const meta = project.documents.scenes[sceneId];
    const key = `love-office-draft:${project.root}:${sceneId}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      try {
        const recovered = JSON.parse(stored) as { revision: string; scene: Scene };
        if (recovered.revision === meta.revision && JSON.stringify(recovered.scene) !== JSON.stringify(sourceScene)) {
          if (window.confirm(`저장하지 않은 '${sourceScene.title}' 초안이 있습니다. 복구할까요?`)) {
            next = recovered.scene;
            recoveredDraft = true;
            setSceneDirty(true);
            setStatus("저장하지 않은 초안을 복구했습니다.");
          } else {
            localStorage.removeItem(key);
            setSceneDirty(false);
          }
        } else {
          localStorage.removeItem(key);
          setSceneDirty(false);
        }
      } catch {
        localStorage.removeItem(key);
        setSceneDirty(false);
      }
    } else setSceneDirty(false);
    setSelectedSceneId(sceneId);
    replaceDraft(next);
    historyGroupRef.current = null;
    draftVersionRef.current = 0;
    setRevision(meta.revision);
    setSelectedNodeId(next.start_node);
    setHistory({ past: [], future: [] });
    setTestState((current) => force ? clone(project.runtime.initial_state) : current || clone(project.runtime.initial_state));
    setEditorTab("node");
    reportSceneActivity({
      phase: recoveredDraft ? "dirty" : "saved",
      label: sourceScene.title,
      path: meta.path,
      detail: recoveredDraft ? "복구한 초안 · 디스크 저장 대기" : "디스크와 동기화됨",
    });
    return recoveredDraft;
  }, [dirty, replaceDraft, reportSceneActivity, setSceneDirty]);

  const loadProject = useCallback(async (projectRoot: string) => {
    setBusy(true);
    setStatus("프로젝트를 검증하고 불러오는 중…");
    try {
      const project = await invoke<ProjectPayload>("load_project", { root: projectRoot });
      setWorkspaceActivities({});
      setPayload(project);
      setLocale(project.runtime.localization.default_locale);
      setIssues(project.issues);
      const firstRoute = storyRoutes(project.runtime)[0];
      const authoringTarget = consumeAuthoringTarget();
      const sceneTarget = authoringTarget?.kind !== "system_flow" ? authoringTarget : undefined;
      const sceneId = sceneTarget && project.runtime.scenes[sceneTarget.sceneId]
        ? sceneTarget.sceneId
        : firstRoute.entry_scene;
      const recoveredDraft = loadScene(project, sceneId, true);
      if (sceneTarget?.nodeId && project.runtime.scenes[sceneId]?.nodes[sceneTarget.nodeId]) {
        setSelectedNodeId(sceneTarget.nodeId);
      }
      if (authoringTarget) {
        const targetWorkspace = authoringTarget.kind === "system_flow" ? "system" : "scene";
        workspaceRef.current = targetWorkspace;
        setWorkspace(targetWorkspace);
      }
      if (!recoveredDraft) setStatus(authoringTarget
        ? authoringTarget.kind === "system_flow"
          ? "게임에서 보던 시스템 대사 원본을 열었습니다."
          : `게임에서 보던 ${sceneId}${authoringTarget.nodeId ? ` · ${authoringTarget.nodeId}` : ""} 원본을 열었습니다.`
        : `${Object.keys(project.runtime.scenes).length}개 장면을 불러왔습니다.`);
    } catch (error) {
      setStatus(`프로젝트를 열 수 없습니다: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [loadScene]);

  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    invoke<string | null>("default_project_root")
      .then((projectRoot) => projectRoot ? loadProject(projectRoot) : setStatus("스토리 프로젝트 폴더를 여세요."))
      .catch(() => setStatus("Tauri 앱에서 실행해 주세요."));
  }, [loadProject]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<AuthoringTarget>("authoring:navigate", ({ payload: target }) => {
      if (target.kind === "system_flow") {
        workspaceRef.current = "system";
        setWorkspace("system");
        setStatus("게임에서 보던 시스템 대사 작업 공간을 열었습니다.");
        return;
      }
      if (!payload || !payload.runtime.scenes[target.sceneId]) return;
      if (target.sceneId !== selectedSceneId) loadScene(payload, target.sceneId);
      if (target.nodeId && payload.runtime.scenes[target.sceneId].nodes[target.nodeId]) {
        workspaceRef.current = "scene";
        setWorkspace("scene");
        setSelectedNodeId(target.nodeId);
      }
    }).then((dispose) => { unlisten = dispose; }).catch(() => undefined));
    return () => unlisten?.();
  }, [loadScene, payload, selectedSceneId]);

  const sceneJournalKey = `draft:${root || "none"}:scene:${draft?.id || "none"}`;
  useDraftJournal({
    enabled: dirty && Boolean(draft && root && revision),
    key: sceneJournalKey,
    projectRoot: root || "",
    baseRevision: revision,
    editVersion: draftVersionRef.current,
    value: draft,
  });

  useEffect(() => {
    if (!draft || !root || !revision) return;
    const recoveryIdentity = `${sceneJournalKey}:${revision}`;
    if (recoveredJournalKeys.current.has(recoveryIdentity)) return;
    recoveredJournalKeys.current.add(recoveryIdentity);
    let cancelled = false;
    void editorDraftJournal.read<Scene>(sceneJournalKey).then((record) => {
      if (cancelled || !record || record.baseRevision !== revision || record.value.id !== draft.id) return;
      if (JSON.stringify(record.value) === JSON.stringify(payload?.runtime.scenes[draft.id])) return;
      if (!window.confirm(`저장하지 않은 '${draft.title}' 비동기 복구 초안이 있습니다. 복구할까요?`)) {
        void editorDraftJournal.remove(sceneJournalKey);
        return;
      }
      draftVersionRef.current = Math.max(draftVersionRef.current, record.editVersion);
      replaceDraft(record.value);
      setSceneDirty(true);
      setStatus("비동기 복구 journal에서 장면 초안을 복구했습니다.");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [draft?.id, payload?.runtime.scenes, replaceDraft, revision, root, sceneJournalKey, setSceneDirty]);

  const commitDraft = useCallback((next: Scene, historyGroup?: string) => {
    const current = draftRef.current;
    if (!current || current === next) return;
    const now = performance.now();
    if (shouldCaptureHistory(historyGroupRef.current, historyGroup, now)) {
      setHistory((value) => ({ past: [...value.past, clone(current)].slice(-100), future: [] }));
    }
    historyGroupRef.current = nextHistoryGroup(historyGroup, now);
    draftVersionRef.current += 1;
    draftRef.current = next;
    setDraftState(next);
    if (!dirtyRef.current) {
      setSceneDirty(true);
      reportSceneActivity({
        phase: "dirty",
        label: next.title,
        path: payload?.documents.scenes[next.id]?.path || "",
        detail: "자동 저장 대기",
      });
    }
  }, [payload?.documents.scenes, reportSceneActivity, setSceneDirty]);

  const updateDraft = useCallback((updater: (scene: Scene) => void, historyGroup?: string) => {
    const current = draftRef.current;
    if (!current) return;
    const next = clone(current);
    updater(next);
    commitDraft(next, historyGroup);
  }, [commitDraft]);

  const updateScene = useCallback((patch: Partial<Scene>, historyGroup?: string) => {
    const current = draftRef.current;
    if (!current) return;
    commitDraft({ ...current, ...patch }, historyGroup);
  }, [commitDraft]);

  const updateNode = useCallback((node: StoryNode) => {
    const current = draftRef.current;
    if (!current || current.nodes[node.id] === node) return;
    commitDraft({ ...current, nodes: { ...current.nodes, [node.id]: node } }, `node:${node.id}`);
  }, [commitDraft]);

  const copyDialogueNode = useCallback((nodeId: string) => {
    const scene = draftRef.current;
    const node = scene?.nodes[nodeId];
    if (!scene || !node) return;
    setDialogueClipboard({ node: clone(node), sourceSceneId: scene.id });
    setDialogueContextMenu(null);
    setStatus(`“${nodePreview(node)}” 대사를 복사했습니다. 붙여넣을 대사를 선택하고 ⌘/Ctrl+V를 누르세요.`);
  }, []);

  const pasteDialogueNode = useCallback((targetId: string) => {
    const scene = draftRef.current;
    if (!scene?.nodes[targetId]) return;
    if (!dialogueClipboard) {
      setStatus("먼저 복사할 대사를 선택하고 ⌘/Ctrl+C를 누르세요.");
      setDialogueContextMenu(null);
      return;
    }

    const copiedId = automaticDialogueId(scene);
    updateDraft((next) => {
      insertNodeCopyAfter(next, dialogueClipboard.node, targetId, copiedId);
    });
    setSelectedNodeId(copiedId);
    setDialogueContextMenu(null);
    setStatus(`복사한 대사를 선택한 대사 바로 다음에 붙여넣었습니다.${dialogueClipboard.sourceSceneId === scene.id ? "" : " 다른 장면의 연결 대상은 저장 전 검증해 주세요."}`);
  }, [dialogueClipboard, updateDraft]);

  const openDialogueContextMenu = useCallback((nodeId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setSelectedNodeId(nodeId);
    const menuWidth = 210;
    const menuHeight = 132;
    setDialogueContextMenu({
      nodeId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    });
  }, []);

  useEffect(() => {
    if (!dialogueContextMenu) return;
    const close = () => setDialogueContextMenu(null);
    const closeOnPrimaryPointer = (event: PointerEvent) => {
      if (event.button === 0) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", closeOnPrimaryPointer);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPrimaryPointer);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [dialogueContextMenu]);

  useEffect(() => {
    historyGroupRef.current = null;
  }, [editorTab, selectedNodeId]);

  const undo = () => {
    if (!draft || history.past.length === 0) return;
    const previous = history.past[history.past.length - 1];
    const changed = JSON.stringify(previous) !== JSON.stringify(payload?.runtime.scenes[previous.id]);
    setHistory({ past: history.past.slice(0, -1), future: [clone(draft), ...history.future].slice(0, 100) });
    historyGroupRef.current = null;
    draftVersionRef.current += 1;
    replaceDraft(previous);
    setSceneDirty(changed);
    reportSceneActivity({
      phase: changed ? "dirty" : "saved",
      label: previous.title,
      path: payload?.documents.scenes[previous.id]?.path || "",
      detail: changed ? "실행 취소됨 · 자동 저장 대기" : "실행 취소됨 · 디스크 상태와 같음",
    });
  };

  const redo = () => {
    if (!draft || history.future.length === 0) return;
    const next = history.future[0];
    const changed = JSON.stringify(next) !== JSON.stringify(payload?.runtime.scenes[next.id]);
    setHistory({ past: [...history.past, clone(draft)].slice(-100), future: history.future.slice(1) });
    historyGroupRef.current = null;
    draftVersionRef.current += 1;
    replaceDraft(next);
    setSceneDirty(changed);
    reportSceneActivity({
      phase: changed ? "dirty" : "saved",
      label: next.title,
      path: payload?.documents.scenes[next.id]?.path || "",
      detail: changed ? "다시 실행됨 · 자동 저장 대기" : "다시 실행됨 · 디스크 상태와 같음",
    });
  };

  const selectProject = async () => {
    const pending = Object.values(workspaceActivities).filter((activity) => activity && activity.phase !== "saved");
    if ((dirty || pending.length > 0) && !window.confirm("아직 저장 중이거나 확인이 필요한 문서가 있습니다. 복구 초안은 보관됩니다. 다른 프로젝트를 열까요?")) return;
    const result = await open({ directory: true, multiple: false, title: "스토리 프로젝트 폴더 선택" });
    if (typeof result === "string") await loadProject(result);
  };

  const validate = async () => {
    if (!root) return;
    setBusy(true);
    try {
      if (draft && workspace === "scene") {
        const result = await invoke<{ issues: ValidationIssue[]; state_contract: Scene["state_contract"] }>("validate_scene", { root, scene: draft });
        setIssues(result.issues);
        const current = draftRef.current;
        if (current?.id === draft.id) replaceDraft({ ...current, state_contract: result.state_contract });
        setStatus(result.issues.length ? `${result.issues.length}개 검증 항목이 있습니다.` : "현재 초안에 오류가 없습니다.");
      } else {
        const result = await invoke<{ issues: ValidationIssue[] }>("validate_project", { root });
        setIssues(result.issues);
        setStatus(result.issues.length ? `${result.issues.length}개 검증 항목이 있습니다.` : "전체 시간표와 장면에 오류가 없습니다.");
      }
    } catch (error) {
      setStatus(`검증 실패: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const commitScene = useCallback(async (snapshot: DocumentSnapshot<Scene>): Promise<SceneCommitResult> => {
    if (!root || !payload) throw new SaveFailure("프로젝트가 열리지 않았습니다.");
    const sceneToSave = {
      ...snapshot.value,
      state_contract: deriveStateContract(snapshot.value, payload.runtime.routes[snapshot.value.route]?.heroine, payload.runtime),
    };
    setStatus("전체 프로젝트를 검증하고 안전하게 저장하는 중…");
    try {
      const result = await editorSaveRepository.saveScene<{
        saved: boolean;
        issues: ValidationIssue[];
        runtime?: Runtime;
        runtimePatch?: RuntimePatch;
        document?: ProjectPayload["documents"]["scenes"][string];
      }>(root, sceneToSave, snapshot.baseRevision);
      setIssues(result.issues);
      if (!result.saved || !result.document || !result.runtime && !result.runtimePatch) {
        setStatus("오류가 있어 원본에는 저장하지 않았습니다.");
        throw new SaveFailure("검증 오류 · 마지막 정상 파일은 보존됨", "validation");
      }
      return { revision: result.document.revision, runtime: result.runtime, runtimePatch: result.runtimePatch, document: result.document, issues: result.issues };
    } catch (error) {
      if (error instanceof SaveFailure) throw error;
      const message = String(error);
      setStatus(message.includes("REVISION_CONFLICT") ? "외부에서 파일이 변경되었습니다. 프로젝트를 다시 불러온 뒤 비교하세요." : `저장 실패: ${message}`);
      throw new SaveFailure(message, message.includes("REVISION_CONFLICT") ? "conflict" : "transient");
    }
  }, [payload, root]);

  const handleSceneCommitted = useCallback((result: SceneCommitResult, completion: SaveCompletion<Scene>) => {
    const sceneId = completion.snapshot.value.id;
    setPayload((current) => current ? {
      ...current,
      runtime: resolveRuntimeUpdate(current.runtime, result),
      documents: {
        ...current.documents,
        scenes: { ...current.documents.scenes, [sceneId]: result.document },
      },
    } : current);
    setIssues(result.issues);
    setRevision(result.revision);
    if (completion.isLatest && draftRef.current?.id === sceneId) {
      historyGroupRef.current = null;
      setSceneDirty(false);
      localStorage.removeItem(`love-office-draft:${completion.snapshot.projectRoot}:${sceneId}`);
      setStatus("YAML과 런타임을 저장했습니다.");
    } else {
      setStatus("입력 중이던 내용은 유지했습니다. 최신 변경을 이어서 백그라운드 저장합니다.");
    }
  }, [replaceDraft, setSceneDirty]);

  const handleSceneSaveState = useCallback((state: SaveState) => {
    const current = draftRef.current;
    if (!current || !payload) return;
    const phase = state.phase === "clean" ? "saved"
      : state.phase === "queued" ? "dirty"
      : state.phase === "conflict" ? "error"
        : state.phase;
    const detail = state.phase === "saving"
      ? state.hasPendingChanges ? "이전 변경 저장 중 · 최신 변경 대기" : "백그라운드 검증·저장 중"
      : state.phase === "queued" ? "백그라운드 저장 대기 중"
        : state.phase === "conflict" ? "외부 변경 충돌 · 현재 초안 보존됨"
          : state.phase === "error" ? state.error || "저장 실패 · 현재 초안 보존됨"
            : state.phase === "dirty" ? "자동 저장 대기" : "YAML + 런타임 저장 완료";
    reportSceneActivity({
      phase,
      label: current.title,
      path: payload.documents.scenes[current.id]?.path || "",
      detail,
      savedAt: state.savedAt,
    });
  }, [payload, reportSceneActivity]);

  const { flush: save } = useDocumentAutosave<Scene, SceneCommitResult>({
    slot: "scene",
    active: workspace === "scene",
    projectRoot: root || "",
    documentKey: `scene:${selectedSceneId || "none"}`,
    revision,
    dirty,
    version: draftVersionRef.current,
    read: () => draftRef.current,
    commit: commitScene,
    onCommitted: handleSceneCommitted,
    onState: handleSceneSaveState,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLocaleLowerCase();
      if (key === "p") {
        event.preventDefault();
        setQuickOpenVisible(true);
        return;
      }
      if (workspace !== "scene") return;
      if (editorTab === "node" && selectedNodeId && !event.altKey && !isTextEditingTarget(event.target)) {
        if (key === "c" && !window.getSelection()?.toString()) {
          event.preventDefault();
          copyDialogueNode(selectedNodeId);
          return;
        }
        if (key === "v") {
          event.preventDefault();
          pasteDialogueNode(selectedNodeId);
          return;
        }
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [copyDialogueNode, dirty, editorTab, history, pasteDialogueNode, save, selectedNodeId, workspace]);

  const quickOpenItems = useMemo<QuickOpenItem[]>(() => {
    if (!payload || !runtime) return [];
    const orderedSceneIds = storyRoutes(runtime).flatMap((route) => [...route.scene_order, ...route.endings.map((ending) => ending.scene)]);
    const scenes = orderedSceneIds.map((sceneId) => runtime.scenes[sceneId]).filter(Boolean).map((scene) => {
      const route = runtime.routes[scene.route];
      const dialogue = scene.node_order.flatMap((id) => {
        const node = scene.nodes[id];
        return [node.prompt, node.stimulus, node.perceived?.line, node.reality?.line];
      }).filter(Boolean).join(" ");
      const context = `${route?.title || scene.route} · ${scene.location || "장소 미정"} · 대사 ${scene.node_order.length}개`;
      return {
        id: scene.id,
        kind: "scene" as const,
        title: scene.title,
        context,
        path: payload.documents.scenes[scene.id]?.path || "",
        search: `${scene.id} ${scene.title} ${scene.purpose} ${context} ${dialogue}`.toLocaleLowerCase(),
      };
    });
    const events = Object.values(runtime.events).map((event) => {
      const campaign = runtime.campaigns[event.campaign_id];
      const lane = campaign?.lanes.find((item) => item.id === event.lane)?.title || event.lane;
      const context = `${campaign?.title || event.campaign_id} · ${event.window.days[0]}~${event.window.days[1]}일 · ${lane}${event.scene ? ` · ${runtime.scenes[event.scene]?.title || event.scene}` : ""}`;
      return {
        id: event.id,
        kind: "event" as const,
        title: event.title,
        context,
        path: payload.documents.events[event.id]?.path || "",
        search: `${event.id} ${event.title} ${event.presentation.perceived.title} ${event.presentation.perceived.summary} ${event.presentation.reality.title} ${event.presentation.reality.summary} ${context}`.toLocaleLowerCase(),
      };
    });
    const characters = storyRoutes(runtime).map((route) => runtime.characters[route.heroine]).filter(Boolean);
    const remainingCharacters = Object.values(runtime.characters).filter((character) => !characters.some((item) => item.id === character.id));
    const characterItems = [...characters, ...remainingCharacters].map((character) => ({
      id: character.id,
      kind: "character" as const,
      title: character.display_name,
      context: `${character.age}세 · ${character.role}`,
      path: payload.documents.characters[character.id]?.path || "",
      search: `${character.id} ${character.display_name} ${character.role} ${character.narrative_role} ${character.summary} ${(character.immutable_facts || []).join(" ")}`.toLocaleLowerCase(),
    }));
    const routeItems = storyRoutes(runtime).map((route) => ({
      id: route.id,
      kind: "route" as const,
      title: route.title,
      context: `${runtime.campaigns[route.campaign_id]?.title || route.campaign_id} · ${runtime.characters[route.heroine]?.display_name || route.heroine} · 스토리 ${route.scene_order.length} · 엔딩 ${route.endings.length}`,
      path: payload.documents.routes[route.id]?.path || "",
      search: `${route.id} ${route.title} ${route.summary} ${route.campaign_id} ${route.scene_order.join(" ")} ${route.endings.map((ending) => `${ending.scene} ${ending.outcome}`).join(" ")}`.toLocaleLowerCase(),
    }));
    const visualItems = Object.values(runtime.visuals).map((visual) => {
      const title = visual.character ? runtime.characters[visual.character]?.display_name || visual.id : runtime.localization.source_strings[visual.title_key || ""] || visual.title_key || visual.id;
      const context = `${visual.kind}${visual.extends ? ` · ${visual.extends} 상속` : ""}`;
      return {
        id: visual.id,
        kind: "visual" as const,
        title,
        context,
        path: payload.documents.visuals[visual.id]?.path || "",
        search: `${visual.id} ${title} ${context} ${(visual.tags || []).join(" ")} ${Object.keys(visual.variants || {}).join(" ")}`.toLocaleLowerCase(),
      };
    });
    const campaignItems = Object.values(runtime.campaigns).map((campaign) => ({
      id: campaign.id,
      kind: "campaign" as const,
      title: campaign.title,
      context: `${campaign.total_days}일 · ${campaign.acts.length}막 · ${campaign.lanes.length}개 레인`,
      path: payload.documents.campaigns[campaign.id]?.path || "",
      search: `${campaign.id} ${campaign.title} ${campaign.total_days} ${(campaign.acts || []).map((act) => `${act.title} ${act.purpose}`).join(" ")} ${(campaign.lanes || []).map((lane) => lane.title).join(" ")}`.toLocaleLowerCase(),
    }));
    const threadItems = Object.values(runtime.threads).map((thread) => ({
      id: thread.id,
      kind: "thread" as const,
      title: thread.title,
      context: `${runtime.campaigns[thread.campaign_id]?.title || thread.campaign_id} · ${thread.events.length}개 사건 · ${thread.lane}`,
      path: payload.documents.threads[thread.id]?.path || "",
      search: `${thread.id} ${thread.title} ${thread.lane} ${thread.events.join(" ")}`.toLocaleLowerCase(),
    }));
    const metaItems = Object.values(runtime.meta).map((meta) => ({
      id: meta.id,
      kind: "meta" as const,
      title: "회차 예고",
      context: `${meta.mode_teasers?.length || 0}개 예고 · 모드 해금은 game_modes.yaml`,
      path: payload.documents.meta[meta.id]?.path || "",
      search: `${meta.id} ${meta.unlock_rules.map((rule) => `${rule.id} ${rule.mode} ${rule.reward}`).join(" ")} ${(meta.mode_teasers || []).flatMap((teaser) => teaser.reveals.map((reveal) => `${reveal.mode} ${reveal.title} ${reveal.teaser}`)).join(" ")}`.toLocaleLowerCase(),
    }));
    return [...scenes, ...events, ...characterItems, ...campaignItems, ...routeItems, ...threadItems, ...metaItems, ...visualItems];
  }, [payload, runtime]);

  const revealActiveDocument = async () => {
    if (!root) return;
    try {
      await invoke("reveal_in_file_manager", { root, relativePath: documentActivity.path || null });
      setStatus(documentActivity.path ? "현재 YAML을 Finder에서 표시했습니다." : "프로젝트 폴더를 Finder에서 열었습니다.");
    } catch (error) {
      setStatus(`Finder를 열 수 없습니다: ${String(error)}`);
    }
  };

  const launchAuthoringPlay = async () => {
    if (!root || busy || dirty || hasPendingDocument) {
      setStatus("저장 중인 문서를 모두 반영한 뒤 게임 편집 모드를 열어 주세요.");
      return;
    }
    rememberAuthoringRoot(root);
    try {
      await openAuthoringPlayWindow(root);
      setStatus("게임 대사 편집 창을 열었습니다. 스토리 에디터는 이 창에 그대로 남아 있습니다.");
    } catch (error) {
      setStatus(`게임 대사 편집 창을 열 수 없습니다: ${String(error)}`);
    }
  };

  const previewCurrentDialogue = async () => {
    if (!root || !draft || !selectedNodeId) return;
    if (dirty || hasPendingDocument) {
      setStatus("현재 장면을 먼저 저장한 뒤 게임에서 대사를 확인해 주세요.");
      return;
    }
    try {
      await openAuthoringPlayWindow(root, { sceneId: draft.id, nodeId: selectedNodeId });
      setStatus(`게임 대사 편집 창에서 '${draft.title}'의 선택한 대사를 열었습니다.`);
    } catch (error) {
      setStatus(`게임에서 대사를 열 수 없습니다: ${String(error)}`);
    }
  };

  const previewSystemDialogue = async (target: SystemFlowAuthoringTarget) => {
    if (!root) return;
    if (hasPendingDocument) {
      setStatus("수정한 시스템 대사가 저장된 뒤 게임에서 확인할 수 있습니다.");
      return;
    }
    try {
      await openAuthoringPlayWindow(root, target);
      setStatus("제작 플레이에서 선택한 시스템 대사를 실제 화면으로 열었습니다.");
    } catch (error) {
      setStatus(`게임에서 시스템 대사를 열 수 없습니다: ${String(error)}`);
    }
  };

  const switchWorkspace = (next: Workspace) => {
    workspaceRef.current = next;
    if (next === "scene" && draft && payload) {
      const activity: DocumentActivity = {
        phase: dirty ? "dirty" : "saved",
        label: draft.title,
        path: payload.documents.scenes[draft.id]?.path || "",
        detail: dirty ? "자동 저장 대기" : "디스크와 동기화됨",
      };
      reportSceneActivity(activity);
    } else if (workspaceActivities[next]) setDocumentActivity(workspaceActivities[next]!);
    setWorkspace(next);
  };

  const openQuickItem = (item: QuickOpenItem) => {
    if (!payload) return;
    setQuickOpenVisible(false);
    if (item.kind === "scene") {
      loadScene(payload, item.id);
      setWorkspace("scene");
      return;
    }
    if (item.kind === "event") {
      setTimelineRequest((current) => ({ id: item.id, token: (current?.token || 0) + 1 }));
      setWorkspace("timeline");
      return;
    }
    if (item.kind === "character") {
      setCharacterRequest((current) => ({ id: item.id, token: (current?.token || 0) + 1 }));
      setWorkspace("character");
      return;
    }
    if (["campaign", "route", "thread", "meta", "visual"].includes(item.kind)) {
      setSettingsRequest((current) => ({ kind: item.kind as SettingsKind, id: item.id, token: (current?.token || 0) + 1 }));
      setWorkspace("settings");
    }
  };

  const requestDuplicate = (kind: "scene" | "event", id: string, title: string) => {
    setDuplicateRequest({ kind, id, title });
  };

  const duplicateDocument = async (newId: string, title: string) => {
    if (!root || !duplicateRequest) return;
    setStatus("최신 편집 내용을 백그라운드 저장한 뒤 복제를 시작합니다…");
    try {
      await editorSaveCoordinator.barrier(root);
      setBusy(true);
      setStatus(`${duplicateRequest.kind === "scene" ? "장면과 연결 일정" : "시간 사건"}을 복사 검증하는 중…`);
      const command = duplicateRequest.kind === "scene" ? "duplicate_scene" : "duplicate_event";
      const result = await invoke<{ created: boolean; issues: ValidationIssue[] }>(command, {
        root,
        sourceId: duplicateRequest.id,
        newId,
        title,
      });
      setIssues(result.issues);
      if (!result.created) {
        setStatus("복제본이 전체 검증을 통과하지 못해 실제 파일은 만들지 않았습니다.");
        return;
      }
      const project = await invoke<ProjectPayload>("load_project", { root });
      setPayload(project);
      setIssues(project.issues);
      setWorkspaceActivities({});
      if (duplicateRequest.kind === "scene") {
        workspaceRef.current = "scene";
        setWorkspace("scene");
        loadScene(project, newId, true);
        setStatus(`'${title}' 장면, 연결 일정과 루트 순서를 만들었습니다: ${project.documents.scenes[newId]?.path}`);
      } else {
        workspaceRef.current = "timeline";
        setWorkspace("timeline");
        setTimelineRequest((current) => ({ id: newId, token: (current?.token || 0) + 1 }));
        setStatus(`'${title}' 사건과 스레드 순서를 만들었습니다: ${project.documents.events[newId]?.path}`);
      }
      setDuplicateRequest(null);
    } catch (error) {
      setStatus(`복제 실패 · 실제 파일은 변경하지 않았습니다: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const build = async () => {
    if (!root) {
      setStatus("프로젝트가 열리지 않았습니다.");
      return;
    }
    setStatus("최신 편집 내용을 백그라운드 저장한 뒤 런타임을 빌드합니다…");
    try {
      await editorSaveCoordinator.barrier(root);
      setBusy(true);
      const result = await invoke<{ built: boolean; issues: ValidationIssue[]; runtime?: Runtime }>("build_runtime", { root });
      setIssues(result.issues);
      if (result.built && result.runtime && payload) {
        setPayload({ ...payload, runtime: result.runtime });
        setStatus("story-runtime.json을 다시 빌드했습니다.");
      } else setStatus("검증 오류로 빌드하지 않았습니다.");
    } catch (error) {
      setStatus(`빌드 실패: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addNode = () => {
    if (!draft || !heroineId) return;
    const id = automaticDialogueId(draft);
    const selectedIndex = draft.node_order.indexOf(selectedNodeId);
    const insertIndex = selectedIndex >= 0 ? selectedIndex + 1 : draft.node_order.length;
    updateDraft((scene) => {
      const current = scene.nodes[selectedNodeId];
      const node = makeNode(newNodeKind, id, heroineId);
      if (current && typeof current.next === "string") {
        const previousNext = current.next;
        current.next = id;
        if (typeof node.next === "string") node.next = previousNext;
      }
      scene.nodes[id] = node;
      scene.node_order.splice(insertIndex, 0, id);
    });
    setSelectedNodeId(id);
    setStatus("선택한 대사 바로 다음에 새 대사를 추가했습니다. ID는 자동으로 관리됩니다.");
  };

  const deleteNode = (nodeId = selectedNodeId) => {
    if (!draft || !nodeId || !draft.nodes[nodeId]) return;
    if (draft.node_order.length <= 1) {
      setStatus("장면에는 최소 한 개의 대사가 필요합니다.");
      setDialogueContextMenu(null);
      return;
    }
    const replacementId = deletionReplacement(draft, nodeId);
    if (!replacementId) {
      setStatus("이 대사 뒤에 연결할 화면이 없습니다. 다음 대사나 장면 이탈을 먼저 추가해 주세요.");
      setDialogueContextMenu(null);
      return;
    }
    const inboundCount = incomingReferenceCount(draft, nodeId);
    const replacementLabel = nodePreview(draft.nodes[replacementId]);
    if (!window.confirm(`“${nodePreview(draft.nodes[nodeId])}” 대사를 삭제할까요?\n\n이 대사를 가리키는 연결 ${inboundCount}개를 “${replacementLabel}” 화면으로 자동 연결합니다.`)) return;
    updateDraft((scene) => {
      deleteNodeAndReconnect(scene, nodeId, replacementId);
    });
    setSelectedNodeId(replacementId);
    setDialogueContextMenu(null);
    setStatus(`대사를 삭제하고 연결 ${inboundCount}개를 다음 화면으로 자동 복구했습니다.`);
  };

  useEffect(() => {
    const onDeleteKey = (event: KeyboardEvent) => {
      if (workspace !== "scene" || editorTab !== "node" || !selectedNodeId) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTextEditingTarget(event.target)) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      event.preventDefault();
      deleteNode();
    };
    window.addEventListener("keydown", onDeleteKey);
    return () => window.removeEventListener("keydown", onDeleteKey);
  }, [draft, editorTab, selectedNodeId, workspace]);

  const moveNode = (offset: number) => {
    if (!draft) return;
    const index = draft.node_order.indexOf(selectedNodeId);
    const target = index + offset;
    if (target < 0 || target >= draft.node_order.length) return;
    updateDraft((scene) => {
      [scene.node_order[index], scene.node_order[target]] = [scene.node_order[target], scene.node_order[index]];
    });
  };

  const selectIssue = (issue: ValidationIssue) => {
    if (!payload) return;
    const sceneId = Object.keys(payload.runtime.scenes).find((id) => issue.location.includes(id));
    if (sceneId && sceneId !== selectedSceneId) loadScene(payload, sceneId);
    const targetScene = payload.runtime.scenes[sceneId || selectedSceneId];
    const node = targetScene?.node_order.find((id) => issue.location.includes(`#${id}`) || issue.location.includes(`nodes[${targetScene.node_order.indexOf(id)}]`));
    if (node) setSelectedNodeId(node);
  };

  const copyValidationForAgent = async () => {
    const actionable = issues.filter((issue) => issue.severity === "error" || issue.severity === "warning");
    if (!actionable.length) {
      setStatus("복사할 검증 오류나 경고가 없습니다.");
      return;
    }
    try {
      await navigator.clipboard.writeText(validationAgentPrompt(actionable));
      setStatus(`검증 오류·경고 ${actionable.length}개를 에이전트용 작업 지시문으로 복사했습니다.`);
    } catch (error) {
      setStatus(`검증 결과를 복사하지 못했습니다: ${String(error)}`);
    }
  };

  if (!payload || !runtime || !root || !draft || !testState) {
    return <main className="empty-shell">
      <div className="empty-card">
        <p className="eyebrow">PUSH &amp; PULL OFFICE</p>
        <h1>스토리 에디터</h1>
        <p>{status}</p>
        <button type="button" className="primary-button" onClick={selectProject} disabled={busy}>프로젝트 폴더 열기</button>
      </div>
    </main>;
  }

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const saveStateLabel = documentActivity.phase === "saving" ? "저장 중…"
    : documentActivity.phase === "dirty" ? "자동 저장 대기"
      : documentActivity.phase === "error" ? "저장 확인 필요"
        : documentActivity.savedAt ? `저장됨 ${new Date(documentActivity.savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
          : "저장됨";
  const hasPendingDocument = Object.values(workspaceActivities).some((activity) => activity && ["dirty", "saving", "error"].includes(activity.phase));

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><p className="eyebrow">PUSH &amp; PULL OFFICE</p><h1>스토리 에디터</h1></div>
      <div className="workspace-switch" aria-label="편집 작업 공간">
        <button type="button" className={workspace === "timeline" ? "active" : ""} onClick={() => switchWorkspace("timeline")}>시간 설계</button>
        <button type="button" className={workspace === "scene" ? "active" : ""} onClick={() => switchWorkspace("scene")}>장면·대사</button>
        <button type="button" className={workspace === "system" ? "active" : ""} onClick={() => switchWorkspace("system")}>시스템 대사</button>
        <button type="button" className={workspace === "character" ? "active" : ""} onClick={() => switchWorkspace("character")}>인물 설정</button>
        <button type="button" className={workspace === "presentation" ? "active" : ""} onClick={() => switchWorkspace("presentation")}>연출·번역</button>
        <button type="button" className={workspace === "settings" ? "active" : ""} onClick={() => switchWorkspace("settings")}>구조·자산</button>
      </div>
      <div className="project-status"><strong>{runtime.project.title}</strong><span className={documentActivity.phase}>{documentActivity.phase === "saved" ? "✓" : "●"} {saveStateLabel}</span><span className={errorCount ? "error" : ""}>{errorCount} 오류</span></div>
      <div className="top-actions">
        <button type="button" className="quick-open-button" onClick={() => setQuickOpenVisible(true)} title="모든 스토리 문서 빠른 열기 (⌘P)">⌕ 빠른 열기 <kbd>⌘P</kbd></button>
        <button type="button" onClick={launchAuthoringPlay} disabled={busy || dirty || hasPendingDocument} title="실제 게임 화면에서 원본 대사를 편집합니다">▶ 게임에서 대사 편집</button>
        <button type="button" onClick={selectProject} disabled={busy}>프로젝트 열기</button>
        {workspace === "scene" && <button type="button" onClick={undo} disabled={!history.past.length || busy} title="실행 취소 (⌘Z)">↶</button>}
        {workspace === "scene" && <button type="button" onClick={redo} disabled={!history.future.length || busy} title="다시 실행 (⇧⌘Z)">↷</button>}
        <button type="button" onClick={validate} disabled={busy}>검증</button>
        <button type="button" onClick={build} disabled={busy || hasPendingDocument}>런타임 빌드</button>
        {workspace === "scene" && <button type="button" className="primary-button" onClick={save} disabled={busy || !dirty}>지금 저장 <kbd>⌘S</kbd></button>}
      </div>
    </header>

    <div className={`status-line ${documentActivity.phase}`} role="status">
      <span>{busy ? "처리 중 · " : ""}{status}</span>
      <div className="active-document">
        <span><strong>{documentActivity.label}</strong><code>{documentActivity.path ? `${root}/${documentActivity.path}` : root}</code><small>{documentActivity.detail}</small></span>
        <button type="button" onClick={revealActiveDocument} title="Finder에서 현재 파일 표시">Finder에서 보기</button>
      </div>
    </div>

    <div className={workspace === "timeline" ? "workspace-pane active" : "workspace-pane"} aria-hidden={workspace !== "timeline"}>
    {visitedWorkspaces.includes("timeline") &&
    <DeferredTimelineEditor
      key={`${payload.root}:timeline`}
      active={workspace === "timeline"}
      payload={payload}
      state={testState}
      mode={mode}
      onMode={setMode}
      onState={setTestState}
      onPayload={setPayload}
      onIssues={setIssues}
      onStatus={setStatus}
      requestedEvent={timelineRequest}
      onDocumentActivity={reportTimelineActivity}
      onDuplicateEvent={(event) => requestDuplicate("event", event.id, event.title)}
      onOpenScene={(sceneId) => {
        loadScene(payload, sceneId);
        setWorkspace("scene");
      }}
    />}
    </div>
    <div className={workspace === "character" ? "workspace-pane active" : "workspace-pane"} aria-hidden={workspace !== "character"}>
    {visitedWorkspaces.includes("character") &&
    <DeferredCharacterEditor
      key={`${payload.root}:characters`}
      active={workspace === "character"}
      payload={payload}
      onStatus={setStatus}
      onPayload={setPayload}
      onIssues={setIssues}
      onDocumentActivity={reportCharacterActivity}
      requestedCharacter={characterRequest}
    />}
    </div>
    <div className={workspace === "system" ? "workspace-pane active" : "workspace-pane"} aria-hidden={workspace !== "system"}>
    {visitedWorkspaces.includes("system") &&
    <DeferredSystemDialogueEditor
      key={`${payload.root}:system-dialogue`}
      active={workspace === "system"}
      payload={payload}
      onStatus={setStatus}
      onPayload={setPayload}
      onIssues={setIssues}
      onDocumentActivity={reportSystemActivity}
      onPreview={(target) => void previewSystemDialogue(target)}
    />}
    </div>
    <div className={workspace === "presentation" ? "workspace-pane active" : "workspace-pane"} aria-hidden={workspace !== "presentation"}>
    {visitedWorkspaces.includes("presentation") &&
    <DeferredPresentationEditor
      key={`${payload.root}:presentation`}
      active={workspace === "presentation"}
      payload={payload}
      locale={locale}
      onLocale={setLocale}
      mode={mode}
      onMode={setMode}
      onStatus={setStatus}
      onPayload={setPayload}
      onIssues={setIssues}
      onDocumentActivity={reportPresentationActivity}
    />}
    </div>
    <div className={workspace === "settings" ? "workspace-pane active" : "workspace-pane"} aria-hidden={workspace !== "settings"}>
    {visitedWorkspaces.includes("settings") &&
    <DeferredProjectSettingsEditor
      key={`${payload.root}:settings`}
      active={workspace === "settings"}
      payload={payload}
      onStatus={setStatus}
      onPayload={setPayload}
      onIssues={setIssues}
      onDocumentActivity={reportSettingsActivity}
      requestedDocument={settingsRequest}
    />}
    </div>
    {workspace === "scene" && <div className={storyFlowCollapsed ? "editor-layout story-flow-collapsed" : "editor-layout"}>
      <nav className={storyFlowCollapsed ? "explorer collapsed" : "explorer"} aria-label="스토리 탐색기">
        <div className="panel-heading">
          <div className="story-flow-heading-copy" hidden={storyFlowCollapsed}><p className="eyebrow">STORY FLOW</p><h2>날짜별 장면</h2></div>
          <button
            type="button"
            className="story-flow-toggle"
            aria-controls="story-flow-content"
            aria-expanded={!storyFlowCollapsed}
            aria-label={storyFlowCollapsed ? "Story Flow 펼치기" : "Story Flow 접기"}
            title={storyFlowCollapsed ? "Story Flow 펼치기" : "Story Flow 접기"}
            onClick={() => setStoryFlowCollapsed((current) => !current)}
          ><span aria-hidden="true">{storyFlowCollapsed ? "›" : "‹"}</span></button>
        </div>
        <div id="story-flow-content" hidden={storyFlowCollapsed}>
          <p className="explorer-help">게임의 시간 순서대로 장면을 선택합니다.</p>
          <div className="day-tree">{sceneDayGroups.map(({ day, scenes }) => <section className={scenes.some((entry) => entry.sceneId === selectedSceneId) ? "day-sector active" : "day-sector"} key={day}>
            <h3><span>{day}일차</span><small>{scenes.length ? `${scenes.length}개 장면` : "장면 없음"}</small></h3>
            {scenes.map((entry) => {
              const scene = runtime.scenes[entry.sceneId];
              return <button type="button" className={entry.sceneId === selectedSceneId ? "scene-link active" : "scene-link"} key={`${entry.eventId}:${entry.sceneId}`} onClick={() => loadScene(payload, entry.sceneId)}>
                <span><strong>{scene?.title || entry.eventTitle}</strong><small>{entry.slot}{entry.endDay !== day ? ` · ${day}~${entry.endDay}일` : ""}</small></span>
                <em>{scene?.node_order.length || 0}</em>
              </button>;
            })}
          </section>)}</div>
        </div>
      </nav>

      <section className="editor-panel">
        <div className="editor-title">
          <div><p className="eyebrow">{draft.id}</p><h2>{draft.title}</h2><p>{draft.purpose}</p></div>
          <div className="editor-title-tools"><button type="button" className="game-dialogue-button" onClick={() => void previewCurrentDialogue()} disabled={busy || dirty || hasPendingDocument || !selectedNodeId}>▶ 게임에서 이 대사 보기</button><button type="button" onClick={() => requestDuplicate("scene", draft.id, draft.title)} disabled={hasPendingDocument || busy}>장면 복제</button></div>
        </div>
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={editorTab === "scene"} className={editorTab === "scene" ? "active" : ""} onClick={() => setEditorTab("scene")}>장면</button>
          <button type="button" role="tab" aria-selected={editorTab === "node"} className={editorTab === "node" ? "active" : ""} onClick={() => setEditorTab("node")}>대사</button>
          <button type="button" role="tab" aria-selected={editorTab === "source"} className={editorTab === "source" ? "active" : ""} onClick={() => setEditorTab("source")}>원본 YAML</button>
        </div>

        {editorTab === "scene" && <div className="scroll-area scene-form">
          <SceneBackgroundEditor root={root} runtime={runtime} scene={draft} onChange={(defaultBackground) => updateScene({ default_background: defaultBackground })} />
          <div className="form-grid">
            <Field label="장면 제목"><TextInput value={draft.title} onChange={(event) => updateScene({ title: event.target.value }, "scene:title")} /></Field>
            <Field label="첫 대사"><select value={draft.start_node} onChange={(event) => updateScene({ start_node: event.target.value })}>{draft.node_order.map((id) => <option value={id} key={id}>{dialogueOptionLabel(draft, id)}</option>)}</select></Field>
            <Field label="장면 목적" wide><TextArea value={draft.purpose} onChange={(event) => updateScene({ purpose: event.target.value }, "scene:purpose")} /></Field>
            <Field label="장소"><TextInput value={draft.location || ""} onChange={(event) => updateScene({ location: event.target.value }, "scene:location")} /></Field>
            <Field label="시간"><TextInput value={draft.time || ""} onChange={(event) => updateScene({ time: event.target.value }, "scene:time")} /></Field>
            <Field label="챕터"><TextInput type="number" min="0" value={draft.chapter || 0} onChange={(event) => updateScene({ chapter: Number(event.target.value) }, "scene:chapter")} /></Field>
            <Field label="정렬 순서"><TextInput type="number" min="0" value={draft.sequence || 0} onChange={(event) => updateScene({ sequence: Number(event.target.value) }, "scene:sequence")} /></Field>
          </div>
          <fieldset className="cast-editor"><legend>출연 인물</legend>{Object.values(runtime.characters).map((character) => <label className="check-row" key={character.id}><input type="checkbox" checked={draft.cast.includes(character.id)} onChange={(event) => updateScene({ cast: event.target.checked ? [...draft.cast, character.id] : draft.cast.filter((id) => id !== character.id) })} /><span>{character.display_name}</span><small>{character.id}</small></label>)}</fieldset>
          <fieldset className="entry-condition-editor"><legend>장면 진입 조건</legend><ConditionEditor runtime={runtime} conditions={draft.entry_conditions || []} onChange={(conditions) => updateScene({ entry_conditions: conditions })} /></fieldset>
          <fieldset className="contract-editor"><legend>자동 계산된 상태 계약</legend><div><strong>읽는 수치</strong>{contract.reads.map((path) => <code key={path}>{path}</code>)}</div><div><strong>바꾸는 수치</strong>{contract.writes.map((path) => <code key={path}>{path}</code>)}</div></fieldset>
        </div>}

        {editorTab === "node" && <div className="node-workspace">
          <aside className="dialogue-sequence">
            <div className="dialogue-sequence-heading"><div><strong>대사 흐름</strong><small>위에서 아래로 실제 진행 순서</small></div><div className="node-actions"><button type="button" aria-label="대사를 위로" title="위로 이동" onClick={() => moveNode(-1)}>↑</button><button type="button" aria-label="대사를 아래로" title="아래로 이동" onClick={() => moveNode(1)}>↓</button><button type="button" className="danger" onClick={() => deleteNode()}>대사 삭제</button></div></div>
            <label className="dialogue-search"><span>대사 내용 검색</span><input type="search" placeholder="화면에 표시되는 문장으로 검색…" value={dialogueSearch} onChange={(event) => setDialogueSearch(event.target.value)} /><small>{visibleDialogueIds.length} / {draft.node_order.length}</small></label>
            <div className="new-node-row"><select aria-label="추가할 대사 종류" value={newNodeKind} onChange={(event) => setNewNodeKind(event.target.value as NodeKind)}>{Object.entries(NODE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><button type="button" onClick={addNode}>현재 대사 다음에 추가</button></div>
            <div className="node-flow" role="list">{visibleDialogueIds.map((id) => {
              const index = dialogueOrder.get(id) ?? 0;
              return <DialogueFlowRow
                id={id}
                index={index}
                preview={nodePreview(draft.nodes[id])}
                kindLabel={NODE_LABELS[draft.nodes[id].kind]}
                active={id === selectedNodeId}
                onSelect={selectDialogueNode}
                onContextMenu={openDialogueContextMenu}
                key={id}
              />;
            })}{visibleDialogueIds.length === 0 && <p className="dialogue-search-empty">검색 결과가 없습니다.</p>}</div>
          </aside>
          {dialogueContextMenu && <div
            className="dialogue-context-menu"
            role="menu"
            aria-label="대사 편집 메뉴"
            style={{ left: dialogueContextMenu.x, top: dialogueContextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button type="button" role="menuitem" onClick={() => copyDialogueNode(dialogueContextMenu.nodeId)}><span>복사</span><kbd>⌘/Ctrl+C</kbd></button>
            <button type="button" role="menuitem" disabled={!dialogueClipboard} onClick={() => pasteDialogueNode(dialogueContextMenu.nodeId)}><span>다음에 붙여넣기</span><kbd>⌘/Ctrl+V</kbd></button>
            <button type="button" role="menuitem" className="danger" onClick={() => deleteNode(dialogueContextMenu.nodeId)}><span>삭제</span><kbd>Delete</kbd></button>
          </div>}
          <div className="dialogue-detail scroll-area">{selectedNode ? <NodeEditor root={root} runtime={runtime} state={testState} scene={draft} node={selectedNode} mode={mode} onMode={setMode} onChange={updateNode} /> : <p>대사를 선택하세요.</p>}</div>
        </div>}

        {editorTab === "source" && <div className="scroll-area source-view"><div className="source-notice">원본은 읽기 전용입니다. 구조화된 폼에서 저장하면 주석과 키 순서를 보존해 갱신합니다.</div><pre><code>{payload.documents.scenes[draft.id]?.source}</code></pre></div>}
      </section>

    </div>}

    <section className="validation-drawer">
      <div className="validation-heading">
        <div><p className="eyebrow">VALIDATION</p><h2>검증 결과</h2></div>
        <div className="validation-actions">
          <span>{issues.length ? `${issues.length}개 항목` : "오류 없음"}</span>
          <button type="button" onClick={copyValidationForAgent} disabled={!issues.some((issue) => issue.severity === "error" || issue.severity === "warning")}>에이전트용으로 복사</button>
        </div>
      </div>
      {issues.length === 0 ? <p className="validation-empty">현재 프로젝트에서 오류나 경고를 찾지 못했습니다.</p> : <div className="issue-list">{issues.map((issue, index) => <button type="button" className={`issue ${issue.severity}`} key={`${issue.location}-${index}`} onClick={() => selectIssue(issue)}><strong>{issue.severity.toUpperCase()}</strong><span>{issue.message}</span><small>{issue.location}</small></button>)}</div>}
    </section>
    {quickOpenVisible && <QuickOpen items={quickOpenItems} onClose={() => setQuickOpenVisible(false)} onPick={openQuickItem} />}
    {duplicateRequest && <DuplicateDialog
      kind={duplicateRequest.kind}
      sourceId={duplicateRequest.id}
      sourceTitle={duplicateRequest.title}
      existingIds={duplicateRequest.kind === "scene" ? Object.keys(runtime.scenes) : Object.keys(runtime.events)}
      busy={busy}
      onCancel={() => setDuplicateRequest(null)}
      onSubmit={duplicateDocument}
    />}
  </main>;
}
