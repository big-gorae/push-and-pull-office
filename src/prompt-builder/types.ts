export type PromptSubject = "female" | "male";
export type PromptLayer = "perceived" | "reality";
export type PromptItem = string;

export type PromptSettings = {
  model: string;
  qualityTags: boolean;
  ucPreset: string;
  guidance: string;
  steps: string;
  samplers: string[];
};

export type PromptFormat = {
  id: string;
  label: string;
  description: string;
  subjectTags: Record<PromptSubject, PromptItem[]>;
  tags: PromptItem[];
  source: string;
};

export type PromptOutfit = {
  id: string;
  label: string;
  description?: string;
  tags: PromptItem[];
};

export type PromptSituation = {
  id: string;
  label: string;
  description?: string;
  expressionId?: string;
  basePresetId: string;
  tags: PromptItem[];
  undesiredTags: PromptItem[];
  source: string;
};

export type PromptVariant = {
  id: string;
  label: string;
  description?: string;
  layer?: PromptLayer;
  identityTags: PromptItem[];
  defaultOutfitId: string;
  outfits: PromptOutfit[];
  fullBodyOnlyTags: PromptItem[];
  characterUndesiredTags: PromptItem[];
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
  palette: string[];
  accent: string;
  subject: PromptSubject;
  defaultVariantId: string;
  variants: PromptVariant[];
  source: string;
};

export type PromptCatalog = {
  schemaVersion: 1;
  settings: PromptSettings;
  formats: PromptFormat[];
  characters: PromptCharacter[];
  styleTags: PromptItem[];
  manualQualityTags: PromptItem[];
  sharedUndesiredTags: PromptItem[];
  source: string;
};

export type PromptSelection = {
  characterId: string;
  variantId?: string;
  formatId?: string;
  outfitId?: string;
  situationId?: string;
  extraPrompt?: string | readonly PromptItem[];
  extraUc?: string | readonly PromptItem[];
};

export type ComposedPrompt = {
  base: string;
  character: string;
  combined: string;
  uc: string;
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
};
