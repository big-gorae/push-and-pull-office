import type {
  Character,
  Condition,
  DecisionTrace,
  Effect,
  EventVerdict,
  JsonValue,
  NodeKind,
  Runtime,
  RuntimeState,
  Scene,
  StoryNode,
  Transition,
  Campaign,
  TimelineEvent,
  TimeSlot,
  DialogueVariant,
  ViewMode,
} from "./types";
import { selfDevelopmentSystem } from "./selfDevelopment";

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Resolves the visible speaker for a layer. An explicit null means narration. */
export function effectiveSpeaker(node: StoryNode | undefined, mode: ViewMode): string | undefined {
  if (!node) return undefined;
  if (node.speakers && Object.prototype.hasOwnProperty.call(node.speakers, mode)) {
    return node.speakers[mode] || undefined;
  }
  return node.speaker;
}

export function getPath(state: RuntimeState, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in value) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, state);
}

export function setPath(state: RuntimeState, path: string, value: unknown): void {
  const parts = path.split(".");
  const key = parts.pop();
  if (!key) return;
  let target: Record<string, unknown> = state as unknown as Record<string, unknown>;
  parts.forEach((part) => {
    const child = target[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) target[part] = {};
    target = target[part] as Record<string, unknown>;
  });
  target[key] = value;
}

export type DerivedCharacterState = {
  rule_id: string | null;
  emotion: string | null;
  behavior: string | null;
  default_expression: string | null;
};

export type EvaluationContext = {
  state: RuntimeState;
  derived: { characters: Record<string, DerivedCharacterState> };
};

function evaluationValue(context: EvaluationContext, path: string): unknown {
  if (!path.startsWith("derived.")) return getPath(context.state, path);
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && key in value) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }, context as unknown);
}

export function conditionMatches(
  state: RuntimeState,
  condition: Condition,
  derived: EvaluationContext["derived"] = { characters: {} },
): boolean {
  const current = evaluationValue({ state, derived }, condition.path);
  if (current === undefined && condition.op !== "exists" && condition.op !== "not_exists") return false;
  switch (condition.op) {
    case "eq": return current === condition.value;
    case "ne": return current !== condition.value;
    case "gt": return Number(current) > Number(condition.value);
    case "gte": return Number(current) >= Number(condition.value);
    case "lt": return Number(current) < Number(condition.value);
    case "lte": return Number(current) <= Number(condition.value);
    case "contains": return Array.isArray(current) && current.includes(condition.value);
    case "not_contains": return Array.isArray(current) && !current.includes(condition.value);
    case "exists": return current !== undefined;
    case "not_exists": return current === undefined;
    default: return false;
  }
}

export function conditionsMatch(
  state: RuntimeState,
  conditions: Condition[] = [],
  derived: EvaluationContext["derived"] = { characters: {} },
): boolean {
  return conditions.every((condition) => conditionMatches(state, condition, derived));
}

export function canEnterScene(
  runtime: Runtime,
  state: RuntimeState,
  sceneId: string,
): { allowed: boolean; trace: Array<{ condition: Condition; actual: unknown; met: boolean }> } {
  const scene = runtime.scenes[sceneId];
  if (!scene) return { allowed: false, trace: [] };
  const context = evaluationContext(runtime, state);
  const trace = (scene.entry_conditions || []).map((condition) => ({
    condition,
    actual: evaluationValue(context, condition.path),
    met: conditionMatches(state, condition, context.derived),
  }));
  return { allowed: trace.every((item) => item.met), trace };
}

export function campaignAct(campaign: Campaign, day: number): number {
  return campaign.acts.find((act) => day >= act.days[0] && day <= act.days[1])?.number || 1;
}

export function inspectTimelineEvent(
  runtime: Runtime,
  event: TimelineEvent,
  state: RuntimeState,
  day: number,
  slot: TimeSlot,
): EventVerdict {
  if (state.progress.events.seen.includes(event.id)) {
    return { event: event.id, status: "seen", eligible: false, reasons: [] };
  }
  if (state.progress.events.missed.includes(event.id) || state.progress.events.expired.includes(event.id) || day > event.window.deadline_day) {
    return { event: event.id, status: "missed", eligible: false, reasons: [`마감 ${event.window.deadline_day}일 경과`] };
  }
  if (day < event.window.days[0]) {
    return { event: event.id, status: "upcoming", eligible: false, reasons: [`${event.window.days[0]}일부터 가능`] };
  }
  if (day > event.window.days[1]) {
    return { event: event.id, status: "missed", eligible: false, reasons: [`발생 기간 ${event.window.days.join("~")}일 종료`] };
  }
  const reasons: string[] = [];
  if (!event.window.slots.includes(slot)) reasons.push("현재 시간대가 아님");
  event.requires.events.forEach((required) => {
    if (!state.progress.events.seen.includes(required)) reasons.push(`선행 사건 미완료: ${required}`);
  });
  event.requires.conditions.forEach((condition) => {
    const context = evaluationContext(runtime, state);
    if (!conditionMatches(state, condition, context.derived)) {
      reasons.push(`조건 불충족: ${condition.path} ${condition.op} ${String(condition.value)} (현재 ${String(evaluationValue(context, condition.path))})`);
    }
  });
  if (event.scene) {
    const decision = canEnterScene(runtime, state, event.scene);
    decision.trace.filter((item) => !item.met).forEach((item) => {
      reasons.push(`장면 진입 조건 불충족: ${item.condition.path} ${item.condition.op} ${String(item.condition.value)} (현재 ${String(item.actual)})`);
    });
  }
  return reasons.length
    ? { event: event.id, status: "blocked", eligible: false, reasons }
    : { event: event.id, status: "eligible", eligible: true, reasons: [] };
}

export function eventsForDay(events: Record<string, TimelineEvent>, day: number): TimelineEvent[] {
  return Object.values(events)
    .filter((event) => day >= event.window.days[0] && day <= event.window.days[1])
    .sort((a, b) => {
      const slotOrder: TimeSlot[] = ["morning", "lunch", "afternoon", "after_work"];
      return slotOrder.indexOf(a.window.slots[0]) - slotOrder.indexOf(b.window.slots[0]) || b.priority - a.priority;
    });
}

function statDefinition(runtime: Runtime, path: string) {
  if (runtime.stats[path]) return runtime.stats[path];
  if (path.includes(".affection")) return runtime.stats["visible.affection"];
  if (path.includes(".initiative")) return runtime.stats["visible.initiative"];
  if (path.includes(".perceived_state")) return runtime.stats["visible.perceived_state"];
  if (path.includes(".suspicion")) return runtime.stats["hidden.suspicion"];
  if (path.includes(".dislike")) return runtime.stats["hidden.dislike"];
  if (path.includes(".evidence_count")) return runtime.stats["hidden.evidence_count"];
  return undefined;
}

export function applyEffect(runtime: Runtime, state: RuntimeState, effect: Effect): void {
  if (!conditionsMatch(state, effect.conditions || [])) return;
  const current = getPath(state, effect.path);
  if (effect.op === "add") {
    const definition = statDefinition(runtime, effect.path);
    let next = Number(current) + Number(effect.value);
    if (definition?.min !== undefined) next = Math.max(definition.min, next);
    if (definition?.max !== undefined) next = Math.min(definition.max, next);
    setPath(state, effect.path, next);
  } else if (effect.op === "set") {
    setPath(state, effect.path, effect.value);
  } else if (effect.op === "append_unique" && Array.isArray(current)) {
    if (!current.includes(effect.value)) current.push(effect.value);
  } else if (effect.op === "remove" && Array.isArray(current)) {
    setPath(state, effect.path, current.filter((value) => value !== effect.value));
  }
}

export function chooseTransition(state: RuntimeState, transitions: Transition[] = []): {
  chosen?: Transition;
  trace: DecisionTrace[];
} {
  let selected = false;
  const trace = transitions.map((transition) => {
    const met = transition.default === true || conditionsMatch(state, transition.conditions || []);
    const chosen = !selected && met;
    if (chosen) selected = true;
    return { transition, met, chosen };
  });
  return { chosen: trace.find((item) => item.chosen)?.transition, trace };
}

export function chooseSceneTransition(
  runtime: Runtime,
  state: RuntimeState,
  transitions: Transition[] = [],
): { chosen?: Transition; trace: Array<DecisionTrace & { entryAllowed?: boolean }> } {
  let selected = false;
  const trace = transitions.map((transition) => {
    const conditionMet = transition.default === true || conditionsMatch(state, transition.conditions || []);
    const entryAllowed = transition.scene ? canEnterScene(runtime, state, transition.scene).allowed : true;
    const met = conditionMet && entryAllowed;
    const chosen = !selected && met;
    if (chosen) selected = true;
    return { transition, met, chosen, entryAllowed };
  });
  return { chosen: trace.find((item) => item.chosen)?.transition, trace };
}

export function resolveStart(scene: Scene, state: RuntimeState): {
  nodeId: string;
  trace: DecisionTrace[];
} {
  let nodeId = scene.start_node;
  let trace: DecisionTrace[] = [];
  for (let index = 0; index < 30; index += 1) {
    const node = scene.nodes[nodeId];
    if (!node || node.kind !== "state_gate") break;
    const decision = chooseTransition(state, node.transitions);
    trace = decision.trace;
    if (!decision.chosen?.node) break;
    nodeId = decision.chosen.node;
  }
  return { nodeId, trace };
}

export function deriveEmotion(character: Character | undefined, hidden: Record<string, number>) {
  const rules = [...(character?.emotion_rules || [])].sort((a, b) => b.priority - a.priority);
  return rules.find((rule) => rule.conditions.every((condition) => {
    const current = hidden[condition.stat];
    if (condition.op === "gte") return current >= Number(condition.value);
    if (condition.op === "lte") return current <= Number(condition.value);
    if (condition.op === "gt") return current > Number(condition.value);
    if (condition.op === "lt") return current < Number(condition.value);
    if (condition.op === "eq") return current === condition.value;
    return false;
  }));
}

export function deriveCharacterState(
  character: Character | undefined,
  state: RuntimeState,
): DerivedCharacterState {
  const hidden = character ? state.hidden.heroines[character.id] : undefined;
  const rule = hidden ? deriveEmotion(character, hidden) : undefined;
  return {
    rule_id: rule?.id || null,
    emotion: rule?.emotion || null,
    behavior: rule?.behavior || null,
    default_expression: rule?.default_expression || null,
  };
}

export function evaluationContext(runtime: Runtime, state: RuntimeState): EvaluationContext {
  return {
    state,
    derived: {
      characters: Object.fromEntries(
        Object.values(runtime.characters).map((character) => [
          character.id,
          deriveCharacterState(character, state),
        ]),
      ),
    },
  };
}

export type ResolvedDialogueNode = {
  node: StoryNode;
  variantId: string;
  trace: Array<{ variantId: string; priority: number; met: boolean; chosen: boolean }>;
};

function variantNode(node: StoryNode, variant: DialogueVariant): StoryNode {
  return {
    ...node,
    perceived: clone(variant.perceived),
    reality: clone(variant.reality),
  };
}

function withRealityExpressionFallback(
  runtime: Runtime,
  state: RuntimeState,
  node: StoryNode,
): StoryNode {
  const speaker = effectiveSpeaker(node, "reality");
  if (node.reality?.expression || !speaker) return node;
  const context = evaluationContext(runtime, state);
  const derivedExpression = context.derived.characters[speaker]?.default_expression;
  const visualExpression = Object.values(runtime.visuals).find((visual) =>
    visual.kind === "character" && !visual.abstract && visual.character === speaker)?.default_reality_expression;
  const expression = derivedExpression || visualExpression;
  return expression ? { ...node, reality: { ...node.reality, expression } } : node;
}

export function resolveDialogueNode(
  runtime: Runtime,
  state: RuntimeState,
  node: StoryNode,
  forcedVariantId?: string,
): ResolvedDialogueNode {
  if (!node.variants?.length) {
    return {
      node: withRealityExpressionFallback(runtime, state, node),
      variantId: "default",
      trace: [{ variantId: "default", priority: 0, met: true, chosen: true }],
    };
  }
  const context = evaluationContext(runtime, state);
  const eligibility = selfDevelopmentSystem(runtime).eligibility;
  const variantMatches = (variant: DialogueVariant): boolean =>
    conditionsMatch(state, variant.conditions || [], context.derived)
      && (!variant.self_development
        || eligibility.isEligible(state, variant.self_development.expression));
  const ordered = node.variants
    .map((variant, index) => ({ variant, index }))
    .sort((left, right) => (right.variant.priority || 0) - (left.variant.priority || 0) || left.index - right.index);
  const forced = forcedVariantId
    ? ordered.find(({ variant }) => variant.id === forcedVariantId)?.variant
    : undefined;
  let selected = forced;
  if (!selected) {
    selected = ordered.find(({ variant }) =>
      variant.default !== true && variantMatches(variant))?.variant;
  }
  selected ||= ordered.find(({ variant }) => variant.default === true)?.variant;
  selected ||= ordered[0].variant;
  const resolved = withRealityExpressionFallback(runtime, state, variantNode(node, selected));
  return {
    node: resolved,
    variantId: selected.id,
    trace: ordered.map(({ variant }) => ({
      variantId: variant.id,
      priority: variant.priority || 0,
      met: variant.default === true || variantMatches(variant),
      chosen: variant.id === selected?.id,
    })),
  };
}

export function statePaths(runtime: Runtime): Array<{ value: string; label: string; type: "number" | "enum" | "array" }> {
  const names: Record<string, string> = {
    affection: "호감도",
    initiative: "밀당 주도권",
    perceived_state: "현재 해석",
    suspicion: "의심도",
    dislike: "비호감",
    evidence_count: "물리적 증거",
  };
  const result: Array<{ value: string; label: string; type: "number" | "enum" | "array" }> = [];
  Object.values(runtime.characters).forEach((character) => {
    const id = character.id;
    const visible = runtime.initial_state.visible.heroines[id];
    const hidden = runtime.initial_state.hidden.heroines[id];
    if (!visible || !hidden) return;
    Object.keys(visible).forEach((stat) => result.push({
      value: `visible.heroines.${id}.${stat}`,
      label: `${character.display_name} / ${names[stat] || stat}`,
      type: stat === "perceived_state" ? "enum" : "number",
    }));
    Object.keys(hidden).forEach((stat) => result.push({
      value: `hidden.heroines.${id}.${stat}`,
      label: `${character.display_name} / ${names[stat] || stat}`,
      type: "number",
    }));
  });
  result.push(
    { value: "progress.cleared_routes", label: "진행 / 클리어 루트", type: "array" },
    { value: "progress.unlocked_modes", label: "진행 / 해금 모드", type: "array" },
    { value: "progress.events.seen", label: "진행 / 본 사건", type: "array" },
    { value: "progress.events.missed", label: "진행 / 놓친 사건", type: "array" },
    { value: "progress.events.expired", label: "진행 / 만료 사건", type: "array" },
    { value: "progress.memories", label: "진행 / 회차 기억", type: "array" },
  );
  return result;
}

function collectConditionPaths(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectConditionPaths(item, result));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (["set", "add", "append_unique", "remove"].includes(String(record.op))) {
      collectConditionPaths(record.conditions, result);
      return;
    }
    if (typeof record.path === "string" && typeof record.op === "string" && !["set", "add", "append_unique", "remove"].includes(record.op)) {
      if (!result.includes(record.path)) result.push(record.path);
    }
    Object.values(record).forEach((child) => collectConditionPaths(child, result));
  }
}

function collectEffectPaths(value: unknown, result: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEffectPaths(item, result));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && ["set", "add", "append_unique", "remove"].includes(String(record.op))) {
      if (!result.includes(record.path)) result.push(record.path);
    }
    Object.values(record).forEach((child) => collectEffectPaths(child, result));
  }
}

export function deriveStateContract(
  scene: Scene,
  heroineId?: string,
  runtime?: Runtime,
): Scene["state_contract"] {
  const reads: string[] = [];
  const writes: string[] = [];
  collectConditionPaths({ entry_conditions: scene.entry_conditions, nodes: scene.nodes }, reads);
  collectEffectPaths(scene.nodes, writes);
  const expressionIds = Object.values(scene.nodes).flatMap((node) => [
    ...(node.variants || []).flatMap((variant) => variant.self_development?.expression || []),
    ...(node.options || []).flatMap((option) => option.self_development?.expression || []),
  ]);
  const selfDevelopmentPaths = new Set<string>();
  expressionIds.forEach((expressionId) => {
    const requirement = runtime?.self_development.expressions[expressionId]?.requires;
    if (!requirement) {
      selfDevelopmentPaths.add("visible.protagonist.self_development.appeal");
      selfDevelopmentPaths.add("visible.protagonist.self_development.fatigue");
      ["stamina", "appearance", "humor", "taste"].forEach((stat) =>
        selfDevelopmentPaths.add(`visible.protagonist.self_development.stats.${stat}`));
      return;
    }
    if (requirement.appeal_gte !== undefined) {
      selfDevelopmentPaths.add("visible.protagonist.self_development.appeal");
    }
    if (requirement.stat) {
      selfDevelopmentPaths.add(`visible.protagonist.self_development.stats.${requirement.stat}`);
    }
    if (requirement.fatigue_lte !== undefined) {
      selfDevelopmentPaths.add("visible.protagonist.self_development.fatigue");
    }
  });
  selfDevelopmentPaths.forEach((path) => {
    if (!reads.includes(path)) reads.push(path);
  });
  const usesPushPull = Object.values(scene.nodes).some((node) =>
    node.kind === "choice" && (node.options || []).some((option) => Boolean(option.push_pull)));
  if (usesPushPull && heroineId) {
    const pushPullPath = "progress.flags.push_pull";
    const initiativePath = `visible.heroines.${heroineId}.initiative`;
    const hiddenPrefix = `hidden.heroines.${heroineId}`;
    if (!reads.includes(pushPullPath)) reads.push(pushPullPath);
    [
      pushPullPath,
      initiativePath,
      `${hiddenPrefix}.suspicion`,
      `${hiddenPrefix}.dislike`,
      `${hiddenPrefix}.evidence_count`,
    ].forEach((path) => {
      if (!writes.includes(path)) writes.push(path);
    });
  }
  return { reads, writes };
}

export function makeNode(kind: NodeKind, id: string, heroineId: string): StoryNode {
  if (kind === "dual_dialogue") {
    return {
      id,
      kind,
      speaker: heroineId,
      perceived: { atmosphere: "warm_romance", expression: "", line: "" },
      reality: { atmosphere: "cold_office", expression: "", line: "", intent: "work_only" },
      next: "",
    };
  }
  if (kind === "dual_narration") {
    return {
      id,
      kind,
      perceived: { atmosphere: "warm_romance", line: "" },
      reality: { atmosphere: "cold_office", line: "", intent: "work_only" },
      next: "",
    };
  }
  if (kind === "choice") return { id, kind, prompt: "", stimulus: "", options: [] };
  if (kind === "state_gate") return { id, kind, transitions: [{ default: true, node: "" }] };
  if (kind === "effect") return { id, kind, effects: [], next: "" };
  return { id, kind: "exit", transitions: [{ default: true, ending: true, ending_id: `draft.${id}` }] };
}

export function parseEditorValue(raw: string, pathType: "number" | "enum" | "array"): JsonValue {
  if (pathType === "number") return Number(raw || 0);
  if (pathType === "array") return raw;
  return raw;
}
