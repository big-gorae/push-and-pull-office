export type PromptSubject = "female" | "male";
export type PromptLayer = "perceived" | "reality";
export type PromptItem = string;
export type PromptInstruction = string;

export type PromptTagSource = {
  id: string;
  label: string;
  url: string;
  checkedAt: string;
  description: string;
};

export type PromptTagRecord = {
  tag: string;
  sourceId: string;
};

export type PromptTagRegistry = {
  sources: PromptTagSource[];
  tags: PromptTagRecord[];
};

export type PromptReferenceImage = {
  id: string;
  label: string;
  path: string;
};

export type PromptSettings = {
  model: string;
  qualityTags: boolean;
  ucPreset: string;
  guidance: string;
  steps: string;
  samplers: string[];
  variety: boolean;
  noiseSchedule: string;
  promptGuidanceRescale: string;
};

export type PromptFormat = {
  id: string;
  label: string;
  description: string;
  subjectTags: Record<PromptSubject, PromptItem[]>;
  tags: PromptItem[];
  instructions: PromptInstruction[];
  source: string;
};

export type PromptOutfit = {
  id: string;
  label: string;
  description?: string;
  tags: PromptItem[];
  instructions: PromptInstruction[];
};

export type PromptInpaintTask = {
  id: string;
  label: string;
  description: string;
  tags: PromptItem[];
  instructions: PromptInstruction[];
};

export type PromptSituation = {
  id: string;
  label: string;
  description?: string;
  expressionId?: string;
  basePresetId: string;
  tags: PromptItem[];
  instructions: PromptInstruction[];
  undesiredTags: PromptItem[];
  undesiredInstructions: PromptInstruction[];
  omitCharacterUndesiredTags: PromptItem[];
  source: string;
};

export type PromptVariant = {
  id: string;
  label: string;
  description?: string;
  layer?: PromptLayer;
  identityTags: PromptItem[];
  identityInstructions: PromptInstruction[];
  defaultOutfitId: string;
  outfits: PromptOutfit[];
  fullBodyOnlyTags: PromptItem[];
  fullBodyOnlyInstructions: PromptInstruction[];
  characterUndesiredTags: PromptItem[];
  characterUndesiredInstructions: PromptInstruction[];
  inpaintTasks: PromptInpaintTask[];
  defaultSituationId: string;
  situations: PromptSituation[];
  source: string;
};

export type PromptCharacter = {
  id: string;
  order: number;
  displayName: string;
  age?: number;
  role?: string;
  narrativeRole?: string;
  conceptArt?: string;
  referenceImages: PromptReferenceImage[];
  palette: string[];
  accent: string;
  subject: PromptSubject;
  defaultVariantId: string;
  variants: PromptVariant[];
  source: string;
};

export type PromptCatalog = {
  schemaVersion: 2;
  settings: PromptSettings;
  formats: PromptFormat[];
  commonSituations: PromptSituation[];
  characters: PromptCharacter[];
  styleTags: PromptItem[];
  styleInstructions: PromptInstruction[];
  manualQualityTags: PromptItem[];
  sharedUndesiredTags: PromptItem[];
  sharedUndesiredInstructions: PromptInstruction[];
  tagRegistry: PromptTagRegistry;
  source: string;
};

export type PromptSelection = {
  characterId: string;
  variantId?: string;
  formatId?: string;
  outfitId?: string;
  situationId?: string;
  extraTags?: string | readonly PromptItem[];
  extraInstructions?: string | readonly PromptInstruction[];
  extraUcTags?: string | readonly PromptItem[];
  extraUcInstructions?: string | readonly PromptInstruction[];
  /** @deprecated Use extraTags. */
  extraPrompt?: string | readonly PromptItem[];
  /** @deprecated Use extraUcTags. */
  extraUc?: string | readonly PromptItem[];
};

export type ComposedPrompt = {
  base: string;
  character: string;
  combined: string;
  uc: string;
  audit: {
    positiveTagItems: PromptItem[];
    positiveInstructions: PromptInstruction[];
    undesiredTagItems: PromptItem[];
    undesiredInstructions: PromptInstruction[];
  };
};

export type PromptConfigIssue = {
  source: string;
  path: string;
  message: string;
};

export class PromptConfigValidationError extends Error {
  readonly issues: PromptConfigIssue[];

  constructor(issues: PromptConfigIssue[]) {
    const detail = issues
      .map((issue) => `${issue.source} ${issue.path}: ${issue.message}`)
      .join("\n");
    super(`NovelAI prompt configuration is invalid:\n${detail}`);
    this.name = "PromptConfigValidationError";
    this.issues = issues;
  }
}

export type RuntimeCharacterMetadata = {
  id: string;
  display_name: string;
  age?: number;
  role?: string;
  narrative_role?: string;
  visual?: {
    concept_art?: string;
    palette?: string[];
  };
  expressions?: Record<string, unknown>;
};

export type PromptRuntimeMetadata = {
  characters: Record<string, RuntimeCharacterMetadata>;
};

export type RawPromptFiles = {
  defaults: Record<string, string>;
  characters: Record<string, string>;
  registry: Record<string, string>;
};
