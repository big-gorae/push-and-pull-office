import type {
  Character,
  Condition,
  DecisionTrace,
  Effect,
  JsonValue,
  NodeKind,
  Runtime,
  RuntimeState,
  Scene,
  StoryNode,
  Transition,
} from "./types";

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

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
    target = target[part] as Record<string, unknown>;
  });
  target[key] = value;
}

export function conditionMatches(state: RuntimeState, condition: Condition): boolean {
  const current = getPath(state, condition.path);
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

export function conditionsMatch(state: RuntimeState, conditions: Condition[] = []): boolean {
  return conditions.every((condition) => conditionMatches(state, condition));
}

function statDefinition(runtime: Runtime, path: string) {
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

export function deriveStateContract(scene: Scene): Scene["state_contract"] {
  const reads: string[] = [];
  const writes: string[] = [];
  collectConditionPaths({ entry_conditions: scene.entry_conditions, nodes: scene.nodes }, reads);
  collectEffectPaths(scene.nodes, writes);
  return { reads, writes };
}

export function makeNode(kind: NodeKind, id: string, heroineId: string): StoryNode {
  if (kind === "dual_dialogue") {
    return {
      id,
      kind,
      speaker: heroineId,
      perceived: { atmosphere: "warm_romance", expression: "", line: "", protagonist_interpretation: "" },
      reality: { atmosphere: "cold_office", expression: "", line: "", inner_thought: "", intent: "work_only" },
      next: "",
    };
  }
  if (kind === "dual_narration") {
    return {
      id,
      kind,
      perceived: { atmosphere: "warm_romance", line: "", protagonist_interpretation: "" },
      reality: { atmosphere: "cold_office", line: "", inner_thought: "", intent: "work_only" },
      next: "",
    };
  }
  if (kind === "choice") return { id, kind, prompt: "", options: [] };
  if (kind === "state_gate") return { id, kind, transitions: [{ default: true, node: "" }] };
  if (kind === "effect") return { id, kind, effects: [], next: "" };
  return { id, kind: "exit", transitions: [{ default: true, ending: true, ending_id: `draft.${id}` }] };
}

export function parseEditorValue(raw: string, pathType: "number" | "enum" | "array"): JsonValue {
  if (pathType === "number") return Number(raw || 0);
  if (pathType === "array") return raw;
  return raw;
}
