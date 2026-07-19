export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type NodeKind = "dual_dialogue" | "dual_narration" | "choice" | "state_gate" | "effect" | "exit";
export type ViewMode = "perceived" | "reality";

export type Condition = {
  path: string;
  op: string;
  value?: JsonValue;
};

export type Effect = {
  path: string;
  op: string;
  value?: JsonValue;
  conditions?: Condition[];
};

export type Transition = {
  conditions?: Condition[];
  default?: boolean;
  node?: string;
  scene?: string;
  ending?: boolean;
  ending_id?: string;
};

export type Layer = {
  atmosphere?: string;
  expression?: string;
  line?: string;
  protagonist_interpretation?: string;
  inner_thought?: string;
  intent?: string;
};

export type ChoiceOption = {
  id: string;
  label: string;
  interpretation: string;
  action: string;
  conditions: Condition[];
  effects: Effect[];
  next: string;
};

export type StoryNode = {
  id: string;
  kind: NodeKind;
  speaker?: string;
  perceived?: Layer;
  reality?: Layer;
  prompt?: string;
  options?: ChoiceOption[];
  transitions?: Transition[];
  effects?: Effect[];
  presentation_flags?: string[];
  next?: string;
};

export type Scene = {
  schema_version: number;
  id: string;
  title: string;
  route: string;
  chapter?: number;
  sequence?: number;
  location?: string;
  time?: string;
  purpose: string;
  cast: string[];
  entry_conditions?: Condition[];
  state_contract: { reads: string[]; writes: string[] };
  start_node: string;
  node_order: string[];
  nodes: Record<string, StoryNode>;
};

export type Route = {
  id: string;
  title: string;
  heroine: string;
  summary: string;
  entry_scene: string;
  scene_order: string[];
  endings: Array<{ scene: string; outcome: string }>;
};

export type Character = {
  id: string;
  display_name: string;
  visual?: { concept_art?: string };
  expressions?: Record<string, { layer: ViewMode; emotion: string; description: string }>;
  emotion_rules?: Array<{
    id: string;
    priority: number;
    conditions: Array<{ stat: string; op: string; value?: JsonValue }>;
    emotion: string;
    behavior: string;
    default_expression: string;
  }>;
};

export type RuntimeState = {
  visible: { heroines: Record<string, { affection: number; initiative: number; perceived_state: string }> };
  hidden: { heroines: Record<string, { suspicion: number; dislike: number; evidence_count: number }> };
  progress: { cleared_routes: string[]; unlocked_modes: string[]; flags: Record<string, JsonValue> };
};

export type Runtime = {
  project: { id: string; title: string; default_language: string };
  generated_at: string;
  enums: Record<string, string[]>;
  stats: Record<string, { type: string; min?: number; max?: number; values?: string[]; description: string }>;
  initial_state: RuntimeState;
  characters: Record<string, Character>;
  routes: Record<string, Route>;
  scenes: Record<string, Scene>;
};

export type DocumentMeta = {
  path: string;
  revision: string;
  source: string;
};

export type ProjectPayload = {
  root: string;
  runtime: Runtime;
  documents: {
    characters: Record<string, DocumentMeta>;
    routes: Record<string, DocumentMeta>;
    scenes: Record<string, DocumentMeta>;
  };
  issues: ValidationIssue[];
};

export type ValidationIssue = {
  severity: "error" | "warning" | "info";
  location: string;
  message: string;
};

export type DecisionTrace = {
  transition: Transition;
  met: boolean;
  chosen: boolean;
};
