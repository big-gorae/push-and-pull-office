export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type NodeKind = "dual_dialogue" | "dual_narration" | "choice" | "state_gate" | "effect" | "exit";
export type ViewMode = "perceived" | "reality";
export type TimeSlot = "morning" | "lunch" | "afternoon" | "after_work";
export type EventType = "anchor" | "heroine" | "company" | "offscreen" | "ending";
export type EventAvailability = "automatic" | "player" | "hidden";
export type LocaleId = string;
export type VisualKind = "background_archetype" | "background" | "character_archetype" | "character";
export type StagePosition = "far_left" | "left" | "center" | "right" | "far_right";

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
  intent?: string;
};

export type SelfDevelopmentStat = "stamina" | "appearance" | "humor" | "taste";

export type SelfDevelopmentRequirement = {
  appeal_gte?: number;
  stat?: SelfDevelopmentStat;
  minimum?: number;
  fatigue_lte?: number;
};

export type SelfDevelopmentChoiceUse = {
  expression: string;
  equivalent_to: string;
  converges_at: string;
};

export type SelfDevelopmentVariantUse = {
  expression: string;
};

export type SelfDevelopmentExpression = {
  requires: SelfDevelopmentRequirement;
  score_bonus: number;
};

export type SelfDevelopmentActivity = {
  id: string;
  title_key: string;
  description_key: string;
  reflection_keys: Record<ViewMode, string>;
  appeal_delta: number;
  fatigue_delta: number;
  stat_deltas: Partial<Record<SelfDevelopmentStat, number>>;
  fatigue_lte?: number;
};

export type SelfDevelopmentConfig = {
  max_night_day: number;
  activities: SelfDevelopmentActivity[];
  expressions: Record<string, SelfDevelopmentExpression>;
};

export type SelfDevelopmentState = {
  appeal: number;
  stats: Record<SelfDevelopmentStat, number>;
  fatigue: number;
};

export type SelfDevelopmentProgress = {
  completed_days: number[];
  activity_history: string[];
  last_activity: string;
};

export type SelfDevelopmentResult = {
  activityId: string;
  appealDelta: number;
  fatigueDelta: number;
  statDeltas: Partial<Record<SelfDevelopmentStat, number>>;
  before: SelfDevelopmentState;
  after: SelfDevelopmentState;
};

export type DialogueVariant = {
  id: string;
  priority?: number;
  conditions?: Condition[];
  default?: boolean;
  self_development?: SelfDevelopmentVariantUse;
  perceived: Layer;
  reality: Layer;
};

export type ChoiceOption = {
  id: string;
  label: string;
  interpretation: string;
  action: string;
  push_pull: PushPullConfig;
  self_development?: SelfDevelopmentChoiceUse;
  conditions: Condition[];
  effects: Effect[];
  next: string;
};

export type PushPullConfig = {
  action: "approach" | "space" | "literal";
  intensity: number;
  base_score: number;
};

export type StoryNode = {
  id: string;
  kind: NodeKind;
  speaker?: string;
  speakers?: Partial<Record<ViewMode, string | null>>;
  perceived?: Layer;
  reality?: Layer;
  variants?: DialogueVariant[];
  prompt?: string;
  stimulus?: string;
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
  world_context?: {
    company: string;
    project: string;
    interaction: string;
    participants: string[];
  };
  entry_conditions?: Condition[];
  state_contract: { reads: string[]; writes: string[] };
  start_node: string;
  node_order: string[];
  nodes: Record<string, StoryNode>;
};

export type Route = {
  schema_version: number;
  id: string;
  title: string;
  heroine: string;
  mode: "base" | "truth_view" | "survivor_view";
  summary: string;
  unlock_conditions: Condition[];
  entry_scene: string;
  scene_order: string[];
  endings: Array<{ scene: string; outcome: string }>;
};

export type Campaign = {
  schema_version: number;
  id: string;
  title: string;
  total_days: number;
  slots: TimeSlot[];
  choice_slots: TimeSlot[];
  calendar?: {
    start_weekday: string;
    weekend_days: number[];
  };
  acts: Array<{ number: number; id: string; title: string; days: [number, number]; purpose: string }>;
  lanes: Array<{ id: string; title: string; kind: "world" | "character" | "truth" }>;
};

export type TimelineEvent = {
  schema_version: number;
  id: string;
  title: string;
  type: EventType;
  lane: string;
  thread?: string;
  sequence?: number;
  exclusive_group?: string;
  window: { days: [number, number]; slots: TimeSlot[]; deadline_day: number };
  duration: number;
  priority: number;
  availability: EventAvailability;
  completion: "return_to_timeline" | "honor_scene_exit";
  participants?: string[];
  location?: string;
  scene?: string;
  requires: { events: string[]; conditions: Condition[] };
  on_seen: { effects: Effect[] };
  on_missed: { effects: Effect[]; trigger_event?: string };
  presentation: Record<ViewMode, { title: string; summary: string }>;
};

export type TimelineThread = {
  schema_version: number;
  id: string;
  title: string;
  lane: string;
  heroine?: string;
  events: string[];
};

export type MetaDocument = {
  schema_version: number;
  id: string;
  unlock_rules: Array<{ id: string; mode: string; reward: string; conditions: Condition[] }>;
  mode_teasers?: Array<{
    id: string;
    conditions: Condition[];
    reveals: Array<{ mode: string; title: string; teaser: string }>;
  }>;
};

export type Character = {
  schema_version: number;
  id: string;
  display_name: string;
  age: number;
  role: string;
  narrative_role: string;
  summary: string;
  immutable_facts: string[];
  voice: {
    register: string;
    habits: string[];
    safe_context?: string;
  };
  visual: {
    concept_art?: string;
    palette?: string[];
    silhouette?: string;
    props?: string[];
  };
  expressions?: Record<string, { layer: ViewMode; emotion: string; description: string }>;
  emotion_rules?: Array<{
    id: string;
    priority: number;
    conditions: Array<{ stat: string; op: string; value?: JsonValue }>;
    emotion: string;
    behavior: string;
    default_expression: string;
  }>;
  reporting_rules?: Array<{
    id: string;
    conditions: Array<{ stat: string; op: string; value?: JsonValue }>;
    action: string;
  }>;
  relationships?: Record<string, string>;
};

export type LocalizationBundle = {
  schema_version?: number;
  default_locale: LocaleId;
  supported_locales: LocaleId[];
  locale_names: Record<LocaleId, { name: string; native_name: string }>;
  locales: Record<LocaleId, {
    schema_version: number;
    id: string;
    name: string;
    native_name?: string;
    fallback: string | null;
    strings: Record<string, string>;
  }>;
  entries?: Record<string, LocalizationEntry>;
  source_strings: Record<string, string>;
  catalogs: Record<LocaleId, Record<string, string>>;
  direct_catalogs?: Record<LocaleId, Record<string, string>>;
  resolved_catalogs?: Record<LocaleId, Record<string, string>>;
  coverage: Record<LocaleId, LocalizationCoverage>;
};

export type LocalizationEntry = {
  key: string;
  source: string;
  domain:
    | "ui"
    | "campaign"
    | "character"
    | "event"
    | "thread"
    | "route"
    | "scene"
    | "meta"
    | "visual"
    | "world"
    | "locale";
  sourceDocument: {
    kind: string;
    id: string;
    path: string;
    fieldPath: string;
  };
  context: {
    sceneId?: string;
    nodeId?: string;
    variantId?: string;
    optionId?: string;
    eventId?: string;
    characterId?: string;
    speakerId?: string;
    layer?: ViewMode;
  };
  placeholders: string[];
  maxLength?: number;
  multiline: boolean;
};

export type LocalizationCoverage = {
  direct: number;
  resolved: number;
  total: number;
  ratio: number;
  fallback_used: string[];
  missing: string[];
  unresolved?: string[];
  orphan: string[];
  invalid_placeholders: string[];
  by_domain: Record<string, { direct: number; total: number }>;
  translated: number;
};

export type VisualMatch = {
  locations?: string[];
  times?: string[];
  atmospheres?: string[];
  modes?: ViewMode[];
};

export type VisualVariant = {
  asset: string;
  match: VisualMatch;
  priority: number;
};

export type VisualObject = {
  schema_version: number;
  id: string;
  kind: VisualKind;
  abstract?: boolean;
  extends?: string;
  title_key?: string;
  title?: string;
  render_strategy?: "flat_portrait" | "layered_sprite" | "background";
  character?: string;
  fallback_asset?: string;
  default_reality_expression?: string;
  default_outfit?: string;
  default_pose?: string;
  outfits?: Record<string, Record<string, JsonValue>>;
  poses?: Record<string, Record<string, JsonValue>>;
  expression_assets?: Record<string, string>;
  variants?: Record<string, VisualVariant>;
  defaults?: Record<string, JsonValue>;
  tags?: string[];
};

export type ResolvedBackground = {
  visual_id: string;
  variant_id: string;
  asset: string;
  title_key?: string;
  defaults: Record<string, JsonValue>;
  score: number;
  matched: string[];
};

export type ResolvedCharacterVisual = {
  visual_id: string;
  character: string;
  asset: string;
  expression?: string;
  outfit?: string;
  pose?: string;
  position: StagePosition;
  speaker: boolean;
  render_strategy: "flat_portrait" | "layered_sprite";
};

export type ResolvedStage = {
  background?: ResolvedBackground;
  characters: ResolvedCharacterVisual[];
  mode: ViewMode;
  node: string;
};

export type RuntimeState = {
  visible: {
    heroines: Record<string, { affection: number; initiative: number; perceived_state: string }>;
    protagonist: { self_development: SelfDevelopmentState };
  };
  hidden: { heroines: Record<string, { suspicion: number; dislike: number; evidence_count: number }> };
  progress: {
    time: { day: number; act: number; slot: TimeSlot };
    events: { seen: string[]; missed: string[]; expired: string[] };
    memories: string[];
    cleared_routes: string[];
    unlocked_modes: string[];
    self_development: SelfDevelopmentProgress;
    flags: Record<string, JsonValue>;
  };
};

export type Runtime = {
  project: { id: string; title: string; default_language: string };
  generated_at: string;
  enums: Record<string, string[]>;
  stats: Record<string, { type: string; min?: number; max?: number; values?: string[]; description: string }>;
  self_development: SelfDevelopmentConfig;
  initial_state: RuntimeState;
  localization: LocalizationBundle;
  campaigns: Record<string, Campaign>;
  characters: Record<string, Character>;
  events: Record<string, TimelineEvent>;
  visuals: Record<string, VisualObject>;
  threads: Record<string, TimelineThread>;
  meta: Record<string, MetaDocument>;
  routes: Record<string, Route>;
  scenes: Record<string, Scene>;
  world?: {
    entities: Record<string, {
      id: string;
      kind: "company" | "role" | "team" | "member" | "project" | "meeting";
      display_name?: string;
      presentation?: "illustrated" | "text_only";
      story_character?: string;
      [key: string]: JsonValue | undefined;
    }>;
    by_kind: Record<string, string[]>;
    story_character_members: Record<string, string>;
  };
};

export type DocumentMeta = {
  path: string;
  revision: string;
  source: string;
};

export type DocumentActivity = {
  phase: "saved" | "dirty" | "saving" | "error";
  label: string;
  path: string;
  detail?: string;
  savedAt?: number;
};

export type ProjectPayload = {
  root: string;
  runtime: Runtime;
  documents: {
    campaigns: Record<string, DocumentMeta>;
    characters: Record<string, DocumentMeta>;
    events: Record<string, DocumentMeta>;
    locales: Record<string, DocumentMeta>;
    visuals: Record<string, DocumentMeta>;
    threads: Record<string, DocumentMeta>;
    meta: Record<string, DocumentMeta>;
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

export type EventVerdict = {
  event: string;
  status: "eligible" | "blocked" | "upcoming" | "seen" | "missed";
  eligible: boolean;
  reasons: string[];
};
