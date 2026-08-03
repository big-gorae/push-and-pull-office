import runtimeJson from "../../build/story-runtime.json";
import { promptTagNames } from "./promptComposer";
import {
  PromptConfigValidationError,
  type PromptCatalog,
  type PromptCharacter,
  type PromptConfigIssue,
  type PromptFormat,
  type PromptLayer,
  type PromptSituation,
  type PromptTagRegistry,
  type PromptRuntimeMetadata,
  type PromptSubject,
  type PromptVariant,
  type RawPromptFiles,
  type RuntimeCharacterMetadata,
} from "./types";

type JsonObject = Record<string, unknown>;

type DefaultsConfig = {
  schemaVersion: 2;
  model: string;
  settings: {
    qualityTags: boolean;
    ucPreset: string;
    guidance: string;
    steps: string;
    samplers: string[];
    variety: boolean;
    noiseSchedule: string;
    promptGuidanceRescale: string;
  };
  styleTags: string[];
  styleInstructions: string[];
  manualQualityTags: string[];
  sharedUndesiredTags: string[];
  sharedUndesiredInstructions: string[];
  commonSituations: Array<{
    id: string;
    label: string;
    description?: string;
    basePresetId: string;
    tags: string[];
    instructions: string[];
    undesiredTags: string[];
    undesiredInstructions: string[];
    omitCharacterUndesiredTags: string[];
  }>;
  basePresets: Array<{
    id: string;
    label: string;
    description: string;
    subjectTags: Record<PromptSubject, string[]>;
    tags: string[];
    instructions: string[];
  }>;
};

type CharacterConfig = {
  schemaVersion: 2;
  characterId: string;
  order: number;
  subject: PromptSubject;
  accent: string;
  referenceImages: Array<{
    id: string;
    label: string;
    path: string;
  }>;
  defaultLookId: string;
  looks: Array<{
    id: string;
    label: string;
    layer?: PromptLayer;
    identityTags: string[];
    identityInstructions: string[];
    outfitTags: string[];
    outfitInstructions: string[];
    fullBodyOnlyTags: string[];
    fullBodyOnlyInstructions: string[];
    characterUndesiredTags: string[];
    characterUndesiredInstructions: string[];
    inpaintTasks: Array<{
      id: string;
      label: string;
      description: string;
      tags: string[];
      instructions: string[];
    }>;
    defaultSituationId: string;
    situations: Array<{
      id: string;
      label: string;
      description?: string;
      expressionId?: string;
      basePresetId: string;
      tags: string[];
      instructions: string[];
      undesiredTags: string[];
      undesiredInstructions: string[];
      omitCharacterUndesiredTags: string[];
    }>;
  }>;
};

type SourcedCharacterConfig = CharacterConfig & { source: string };

const rawDefaults = import.meta.glob(
  "../../prompt-config/novelai-v45/defaults.json",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const rawCharacters = import.meta.glob(
  "../../prompt-config/novelai-v45/characters/*.json",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const rawRegistry = import.meta.glob(
  "../../prompt-config/novelai-v45/tag-registry.json",
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

function sourceName(source: string): string {
  const marker = "prompt-config/novelai-v45/";
  const markerIndex = source.indexOf(marker);
  return markerIndex >= 0 ? source.slice(markerIndex) : source;
}

function fail(source: string, path: string, message: string): never {
  const issue: PromptConfigIssue = { source: sourceName(source), path, message };
  throw new PromptConfigValidationError([issue]);
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(source, "$", `invalid JSON (${detail})`);
  }
}

function objectAt(value: unknown, source: string, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(source, path, "expected an object");
  }
  return value as JsonObject;
}

function arrayAt(value: unknown, source: string, path: string): unknown[] {
  if (!Array.isArray(value)) return fail(source, path, "expected an array");
  return value;
}

function stringAt(value: unknown, source: string, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fail(source, path, "expected a non-empty string");
  }
  return value.trim();
}

function optionalStringAt(value: unknown, source: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringAt(value, source, path);
}

function booleanAt(value: unknown, source: string, path: string): boolean {
  if (typeof value !== "boolean") return fail(source, path, "expected a boolean");
  return value;
}

function numberAt(value: unknown, source: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(source, path, "expected a finite number");
  }
  return value;
}

function schemaVersionOneAt(value: unknown, source: string): 1 {
  if (value !== 1) return fail(source, "$.schemaVersion", "expected schema version 1");
  return value;
}

function schemaVersionTwoAt(value: unknown, source: string): 2 {
  if (value !== 2) return fail(source, "$.schemaVersion", "expected schema version 2");
  return value;
}

function stringArrayAt(
  value: unknown,
  source: string,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  const values = arrayAt(value, source, path);
  if (!options.allowEmpty && values.length === 0) {
    return fail(source, path, "expected at least one item");
  }
  // Every entry is deliberately atomic. In particular, weighted NovelAI items
  // such as `1.1::hair, eyes, face::` must never be split on their commas.
  return values.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = stringAt(entry, source, itemPath);
    if (item.endsWith(",")) fail(source, itemPath, "do not include a trailing comma");
    return item;
  });
}

function instructionArrayAt(
  value: unknown,
  source: string,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  return stringArrayAt(value, source, path, options).map((instruction, index) => {
    const itemPath = `${path}[${index}]`;
    if (!/^[A-Z]/.test(instruction)) {
      fail(source, itemPath, "natural-language instructions must start with an uppercase letter");
    }
    if (!/[.!?]$/.test(instruction)) {
      fail(source, itemPath, "natural-language instructions must end with punctuation");
    }
    return instruction;
  });
}

function tagArrayAt(
  value: unknown,
  source: string,
  path: string,
  registry: PromptTagRegistry,
  options: { allowEmpty?: boolean } = {},
): string[] {
  const items = stringArrayAt(value, source, path, options);
  const registeredTags = new Set(registry.tags.map(({ tag }) => tag));
  items.forEach((item, index) => {
    let tags: string[];
    try {
      tags = promptTagNames(item);
    } catch (error) {
      fail(source, `${path}[${index}]`, error instanceof Error ? error.message : String(error));
    }
    for (const tag of tags) {
      if (!registeredTags.has(tag)) {
        fail(
          source,
          `${path}[${index}]`,
          `unregistered tag ${JSON.stringify(tag)}; verify it and add it to tag-registry.json or move it to an instructions field`,
        );
      }
    }
  });
  return items;
}

function uniqueId(id: string, seen: Set<string>, source: string, path: string): void {
  if (seen.has(id)) fail(source, path, `duplicate id ${JSON.stringify(id)}`);
  seen.add(id);
}

function parseTagRegistry(raw: string, source: string): PromptTagRegistry {
  const root = objectAt(parseJson(raw, source), source, "$");
  schemaVersionOneAt(root.schemaVersion, source);
  const sourceValues = arrayAt(root.sources, source, "$.sources");
  const sourceIds = new Set<string>();
  const sources = sourceValues.map((value, index) => {
    const path = `$.sources[${index}]`;
    const entry = objectAt(value, source, path);
    const id = stringAt(entry.id, source, `${path}.id`);
    uniqueId(id, sourceIds, source, `${path}.id`);
    return {
      id,
      label: stringAt(entry.label, source, `${path}.label`),
      url: stringAt(entry.url, source, `${path}.url`),
      checkedAt: stringAt(entry.checkedAt, source, `${path}.checkedAt`),
      description: stringAt(entry.description, source, `${path}.description`),
    };
  });
  if (!sources.length) fail(source, "$.sources", "expected at least one source");

  const tagValues = arrayAt(root.tags, source, "$.tags");
  const seenTags = new Set<string>();
  const tags = tagValues.map((value, index) => {
    const path = `$.tags[${index}]`;
    const entry = objectAt(value, source, path);
    const tag = stringAt(entry.tag, source, `${path}.tag`);
    uniqueId(tag, seenTags, source, `${path}.tag`);
    const sourceId = stringAt(entry.sourceId, source, `${path}.sourceId`);
    if (!sourceIds.has(sourceId)) {
      fail(source, `${path}.sourceId`, `unknown source id ${JSON.stringify(sourceId)}`);
    }
    return { tag, sourceId };
  });
  if (!tags.length) fail(source, "$.tags", "expected at least one verified tag");
  return { sources, tags };
}

function parseDefaults(raw: string, source: string, registry: PromptTagRegistry): DefaultsConfig {
  const root = objectAt(parseJson(raw, source), source, "$");
  const settings = objectAt(root.settings, source, "$.settings");
  const basePresetValues = arrayAt(root.basePresets, source, "$.basePresets");
  if (!basePresetValues.length) fail(source, "$.basePresets", "expected at least one preset");

  const presetIds = new Set<string>();
  const basePresets = basePresetValues.map((value, index) => {
    const path = `$.basePresets[${index}]`;
    const preset = objectAt(value, source, path);
    const id = stringAt(preset.id, source, `${path}.id`);
    uniqueId(id, presetIds, source, `${path}.id`);
    const subjectTags = objectAt(preset.subjectTags, source, `${path}.subjectTags`);
    return {
      id,
      label: stringAt(preset.label, source, `${path}.label`),
      description: stringAt(preset.description, source, `${path}.description`),
      subjectTags: {
        female: tagArrayAt(subjectTags.female, source, `${path}.subjectTags.female`, registry),
        male: tagArrayAt(subjectTags.male, source, `${path}.subjectTags.male`, registry),
      },
      tags: tagArrayAt(preset.tags, source, `${path}.tags`, registry),
      instructions: instructionArrayAt(
        preset.instructions,
        source,
        `${path}.instructions`,
        { allowEmpty: true },
      ),
    };
  });

  const commonSituationValues = root.commonSituations === undefined
    ? []
    : arrayAt(root.commonSituations, source, "$.commonSituations");
  const commonSituationIds = new Set<string>();
  const commonSituations = commonSituationValues.map((value, index) => {
    const path = `$.commonSituations[${index}]`;
    const situation = objectAt(value, source, path);
    const id = stringAt(situation.id, source, `${path}.id`);
    uniqueId(id, commonSituationIds, source, `${path}.id`);
    const basePresetId = stringAt(situation.basePresetId, source, `${path}.basePresetId`);
    if (!presetIds.has(basePresetId)) {
      fail(source, `${path}.basePresetId`, `unknown base preset ${JSON.stringify(basePresetId)}`);
    }
    return {
      id,
      label: stringAt(situation.label, source, `${path}.label`),
      description: optionalStringAt(situation.description, source, `${path}.description`),
      basePresetId,
      tags: tagArrayAt(situation.tags, source, `${path}.tags`, registry, { allowEmpty: true }),
      instructions: instructionArrayAt(
        situation.instructions,
        source,
        `${path}.instructions`,
        { allowEmpty: true },
      ),
      undesiredTags: situation.undesiredTags === undefined
        ? []
        : tagArrayAt(
            situation.undesiredTags,
            source,
            `${path}.undesiredTags`,
            registry,
            { allowEmpty: true },
          ),
      undesiredInstructions: situation.undesiredInstructions === undefined
        ? []
        : instructionArrayAt(
            situation.undesiredInstructions,
            source,
            `${path}.undesiredInstructions`,
            { allowEmpty: true },
          ),
      omitCharacterUndesiredTags: situation.omitCharacterUndesiredTags === undefined
        ? []
        : tagArrayAt(
            situation.omitCharacterUndesiredTags,
            source,
            `${path}.omitCharacterUndesiredTags`,
            registry,
            { allowEmpty: true },
          ),
    };
  });

  return {
    schemaVersion: schemaVersionTwoAt(root.schemaVersion, source),
    model: stringAt(root.model, source, "$.model"),
    settings: {
      qualityTags: booleanAt(settings.qualityTags, source, "$.settings.qualityTags"),
      ucPreset: stringAt(settings.ucPreset, source, "$.settings.ucPreset"),
      guidance: stringAt(settings.guidance, source, "$.settings.guidance"),
      steps: stringAt(settings.steps, source, "$.settings.steps"),
      samplers: stringArrayAt(settings.samplers, source, "$.settings.samplers"),
      variety: booleanAt(settings.variety, source, "$.settings.variety"),
      noiseSchedule: stringAt(settings.noiseSchedule, source, "$.settings.noiseSchedule"),
      promptGuidanceRescale: stringAt(
        settings.promptGuidanceRescale,
        source,
        "$.settings.promptGuidanceRescale",
      ),
    },
    styleTags: tagArrayAt(root.styleTags, source, "$.styleTags", registry),
    styleInstructions: instructionArrayAt(root.styleInstructions, source, "$.styleInstructions"),
    manualQualityTags: tagArrayAt(root.manualQualityTags, source, "$.manualQualityTags", registry),
    sharedUndesiredTags: tagArrayAt(root.sharedUndesiredTags, source, "$.sharedUndesiredTags", registry),
    sharedUndesiredInstructions: instructionArrayAt(
      root.sharedUndesiredInstructions,
      source,
      "$.sharedUndesiredInstructions",
      { allowEmpty: true },
    ),
    commonSituations,
    basePresets,
  };
}

function promptSubjectAt(value: unknown, source: string, path: string): PromptSubject {
  if (value !== "female" && value !== "male") {
    return fail(source, path, "expected \"female\" or \"male\"");
  }
  return value;
}

function promptLayerAt(value: unknown, source: string, path: string): PromptLayer | undefined {
  if (value === undefined) return undefined;
  if (value !== "perceived" && value !== "reality") {
    return fail(source, path, "expected \"perceived\" or \"reality\"");
  }
  return value;
}

function parseCharacter(
  raw: string,
  source: string,
  registry: PromptTagRegistry,
): SourcedCharacterConfig {
  const root = objectAt(parseJson(raw, source), source, "$");
  const referenceImageValues = root.referenceImages === undefined
    ? []
    : arrayAt(root.referenceImages, source, "$.referenceImages");
  const referenceImageIds = new Set<string>();
  const referenceImages = referenceImageValues.map((value, index) => {
    const path = `$.referenceImages[${index}]`;
    const image = objectAt(value, source, path);
    const id = stringAt(image.id, source, `${path}.id`);
    uniqueId(id, referenceImageIds, source, `${path}.id`);
    const imagePath = stringAt(image.path, source, `${path}.path`);
    if (!/^assets\/concept-art\/[a-z0-9][a-z0-9-]*\.png$/.test(imagePath)) {
      fail(source, `${path}.path`, "expected an assets/concept-art/<kebab-case>.png path");
    }
    return {
      id,
      label: stringAt(image.label, source, `${path}.label`),
      path: imagePath,
    };
  });
  const lookValues = arrayAt(root.looks, source, "$.looks");
  if (!lookValues.length) fail(source, "$.looks", "expected at least one look");

  const lookIds = new Set<string>();
  const looks = lookValues.map((value, lookIndex) => {
    const lookPath = `$.looks[${lookIndex}]`;
    const look = objectAt(value, source, lookPath);
    const id = stringAt(look.id, source, `${lookPath}.id`);
    uniqueId(id, lookIds, source, `${lookPath}.id`);

    const situationValues = arrayAt(look.situations, source, `${lookPath}.situations`);
    if (!situationValues.length) {
      fail(source, `${lookPath}.situations`, "expected at least one situation");
    }
    const situationIds = new Set<string>();
    const situations = situationValues.map((situationValue, situationIndex) => {
      const path = `${lookPath}.situations[${situationIndex}]`;
      const situation = objectAt(situationValue, source, path);
      const situationId = stringAt(situation.id, source, `${path}.id`);
      uniqueId(situationId, situationIds, source, `${path}.id`);
      return {
        id: situationId,
        label: stringAt(situation.label, source, `${path}.label`),
        description: optionalStringAt(situation.description, source, `${path}.description`),
        expressionId: optionalStringAt(situation.expressionId, source, `${path}.expressionId`),
        basePresetId: stringAt(situation.basePresetId, source, `${path}.basePresetId`),
        tags: tagArrayAt(situation.tags, source, `${path}.tags`, registry, { allowEmpty: true }),
        instructions: instructionArrayAt(
          situation.instructions,
          source,
          `${path}.instructions`,
          { allowEmpty: true },
        ),
        undesiredTags: situation.undesiredTags === undefined
          ? []
          : tagArrayAt(
              situation.undesiredTags,
              source,
              `${path}.undesiredTags`,
              registry,
              { allowEmpty: true },
            ),
        undesiredInstructions: situation.undesiredInstructions === undefined
          ? []
          : instructionArrayAt(
              situation.undesiredInstructions,
              source,
              `${path}.undesiredInstructions`,
              { allowEmpty: true },
            ),
        omitCharacterUndesiredTags: situation.omitCharacterUndesiredTags === undefined
          ? []
          : tagArrayAt(
              situation.omitCharacterUndesiredTags,
              source,
              `${path}.omitCharacterUndesiredTags`,
              registry,
              { allowEmpty: true },
            ),
      };
    });

    const inpaintTaskValues = look.inpaintTasks === undefined
      ? []
      : arrayAt(look.inpaintTasks, source, `${lookPath}.inpaintTasks`);
    const inpaintTaskIds = new Set<string>();
    const inpaintTasks = inpaintTaskValues.map((taskValue, taskIndex) => {
      const path = `${lookPath}.inpaintTasks[${taskIndex}]`;
      const task = objectAt(taskValue, source, path);
      const taskId = stringAt(task.id, source, `${path}.id`);
      uniqueId(taskId, inpaintTaskIds, source, `${path}.id`);
      return {
        id: taskId,
        label: stringAt(task.label, source, `${path}.label`),
        description: stringAt(task.description, source, `${path}.description`),
        tags: tagArrayAt(task.tags, source, `${path}.tags`, registry, { allowEmpty: true }),
        instructions: instructionArrayAt(
          task.instructions,
          source,
          `${path}.instructions`,
          { allowEmpty: true },
        ),
      };
    });

    const defaultSituationId = stringAt(
      look.defaultSituationId,
      source,
      `${lookPath}.defaultSituationId`,
    );
    if (!situationIds.has(defaultSituationId)) {
      fail(
        source,
        `${lookPath}.defaultSituationId`,
        `unknown situation id ${JSON.stringify(defaultSituationId)}`,
      );
    }

    return {
      id,
      label: stringAt(look.label, source, `${lookPath}.label`),
      layer: promptLayerAt(look.layer, source, `${lookPath}.layer`),
      identityTags: tagArrayAt(look.identityTags, source, `${lookPath}.identityTags`, registry),
      identityInstructions: instructionArrayAt(
        look.identityInstructions,
        source,
        `${lookPath}.identityInstructions`,
        { allowEmpty: true },
      ),
      outfitTags: tagArrayAt(look.outfitTags, source, `${lookPath}.outfitTags`, registry),
      outfitInstructions: instructionArrayAt(
        look.outfitInstructions,
        source,
        `${lookPath}.outfitInstructions`,
        { allowEmpty: true },
      ),
      fullBodyOnlyTags: look.fullBodyOnlyTags === undefined
        ? []
        : tagArrayAt(
            look.fullBodyOnlyTags,
            source,
            `${lookPath}.fullBodyOnlyTags`,
            registry,
            { allowEmpty: true },
          ),
      fullBodyOnlyInstructions: look.fullBodyOnlyInstructions === undefined
        ? []
        : instructionArrayAt(
            look.fullBodyOnlyInstructions,
            source,
            `${lookPath}.fullBodyOnlyInstructions`,
            { allowEmpty: true },
          ),
      characterUndesiredTags: tagArrayAt(
        look.characterUndesiredTags,
        source,
        `${lookPath}.characterUndesiredTags`,
        registry,
        { allowEmpty: true },
      ),
      characterUndesiredInstructions: instructionArrayAt(
        look.characterUndesiredInstructions,
        source,
        `${lookPath}.characterUndesiredInstructions`,
        { allowEmpty: true },
      ),
      inpaintTasks,
      defaultSituationId,
      situations,
    };
  });

  const defaultLookId = stringAt(root.defaultLookId, source, "$.defaultLookId");
  if (!lookIds.has(defaultLookId)) {
    fail(source, "$.defaultLookId", `unknown look id ${JSON.stringify(defaultLookId)}`);
  }

  return {
    schemaVersion: schemaVersionTwoAt(root.schemaVersion, source),
    characterId: stringAt(root.characterId, source, "$.characterId"),
    order: numberAt(root.order, source, "$.order"),
    subject: promptSubjectAt(root.subject, source, "$.subject"),
    accent: stringAt(root.accent, source, "$.accent"),
    referenceImages,
    defaultLookId,
    looks,
    source: sourceName(source),
  };
}

function runtimeCharacter(
  runtime: PromptRuntimeMetadata,
  config: SourcedCharacterConfig,
): RuntimeCharacterMetadata {
  const character = runtime.characters[config.characterId];
  if (!character) {
    fail(
      config.source,
      "$.characterId",
      `character ${JSON.stringify(config.characterId)} does not exist in build/story-runtime.json`,
    );
  }
  return character;
}

function validateCharacterReferences(
  config: SourcedCharacterConfig,
  metadata: RuntimeCharacterMetadata,
  formatIds: Set<string>,
  commonSituationIds: Set<string>,
): void {
  config.looks.forEach((look, lookIndex) => {
    look.situations.forEach((situation, situationIndex) => {
      const path = `$.looks[${lookIndex}].situations[${situationIndex}]`;
      if (commonSituationIds.has(situation.id)) {
        fail(
          config.source,
          `${path}.id`,
          `situation id ${JSON.stringify(situation.id)} conflicts with a common situation`,
        );
      }
      if (!formatIds.has(situation.basePresetId)) {
        fail(
          config.source,
          `${path}.basePresetId`,
          `unknown base preset ${JSON.stringify(situation.basePresetId)}`,
        );
      }
      if (situation.expressionId && !metadata.expressions?.[situation.expressionId]) {
        fail(
          config.source,
          `${path}.expressionId`,
          `expression ${JSON.stringify(situation.expressionId)} does not exist on ${config.characterId} in build/story-runtime.json`,
        );
      }
      const expression = situation.expressionId
        ? metadata.expressions?.[situation.expressionId] as { layer?: unknown } | undefined
        : undefined;
      if (look.layer && expression?.layer && expression.layer !== look.layer) {
        fail(
          config.source,
          `${path}.expressionId`,
          `expression layer ${JSON.stringify(expression.layer)} does not match look layer ${JSON.stringify(look.layer)}`,
        );
      }
    });
  });
}

function normalizeSituation(
  situation: CharacterConfig["looks"][number]["situations"][number] | DefaultsConfig["commonSituations"][number],
  source: string,
): PromptSituation {
  return {
    id: situation.id,
    label: situation.label,
    description: situation.description,
    expressionId: "expressionId" in situation ? situation.expressionId : undefined,
    basePresetId: situation.basePresetId,
    tags: [...situation.tags],
    instructions: [...situation.instructions],
    undesiredTags: [...situation.undesiredTags],
    undesiredInstructions: [...situation.undesiredInstructions],
    omitCharacterUndesiredTags: [...situation.omitCharacterUndesiredTags],
    source,
  };
}

function normalizeVariant(
  config: SourcedCharacterConfig,
  look: CharacterConfig["looks"][number],
  commonSituations: DefaultsConfig["commonSituations"],
  defaultsSource: string,
): PromptVariant {
  return {
    id: look.id,
    label: look.label,
    layer: look.layer,
    identityTags: [...look.identityTags],
    identityInstructions: [...look.identityInstructions],
    defaultOutfitId: "default",
    outfits: [{
      id: "default",
      label: "기본 의상",
      tags: [...look.outfitTags],
      instructions: [...look.outfitInstructions],
    }],
    fullBodyOnlyTags: [...look.fullBodyOnlyTags],
    fullBodyOnlyInstructions: [...look.fullBodyOnlyInstructions],
    characterUndesiredTags: [...look.characterUndesiredTags],
    characterUndesiredInstructions: [...look.characterUndesiredInstructions],
    inpaintTasks: look.inpaintTasks.map((task) => ({
      ...task,
      tags: [...task.tags],
      instructions: [...task.instructions],
    })),
    defaultSituationId: look.defaultSituationId,
    situations: [
      ...look.situations.map((situation) => normalizeSituation(situation, config.source)),
      ...commonSituations.map((situation) => normalizeSituation(situation, defaultsSource)),
    ],
    source: config.source,
  };
}

function normalizeCharacter(
  config: SourcedCharacterConfig,
  metadata: RuntimeCharacterMetadata,
  commonSituations: DefaultsConfig["commonSituations"],
  defaultsSource: string,
): PromptCharacter {
  return {
    id: config.characterId,
    order: config.order,
    displayName: metadata.display_name,
    age: metadata.age,
    role: metadata.role,
    narrativeRole: metadata.narrative_role,
    conceptArt: metadata.visual?.concept_art,
    referenceImages: config.referenceImages.map((image) => ({ ...image })),
    palette: [...(metadata.visual?.palette || [])],
    accent: config.accent,
    subject: config.subject,
    defaultVariantId: config.defaultLookId,
    variants: config.looks.map((look) => (
      normalizeVariant(config, look, commonSituations, defaultsSource)
    )),
    source: config.source,
  };
}

export function parsePromptCatalog(
  files: RawPromptFiles,
  runtime: PromptRuntimeMetadata,
): PromptCatalog {
  const registryEntries = Object.entries(files.registry);
  if (registryEntries.length !== 1) {
    fail(
      "prompt-config/novelai-v45/tag-registry.json",
      "$",
      `expected exactly one tag registry file, found ${registryEntries.length}`,
    );
  }
  const [rawRegistrySource, registryRaw] = registryEntries[0];
  const registry = parseTagRegistry(registryRaw, sourceName(rawRegistrySource));

  const defaultsEntries = Object.entries(files.defaults);
  if (defaultsEntries.length !== 1) {
    fail(
      "prompt-config/novelai-v45/defaults.json",
      "$",
      `expected exactly one defaults file, found ${defaultsEntries.length}`,
    );
  }

  const [rawDefaultsSource, defaultsRaw] = defaultsEntries[0];
  const defaultsSource = sourceName(rawDefaultsSource);
  const defaults = parseDefaults(defaultsRaw, defaultsSource, registry);
  const formatIds = new Set(defaults.basePresets.map((preset) => preset.id));
  const commonSituationIds = new Set(defaults.commonSituations.map(({ id }) => id));

  const characterEntries = Object.entries(files.characters)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!characterEntries.length) {
    fail("prompt-config/novelai-v45/characters", "$", "expected at least one character file");
  }

  const characterIds = new Set<string>();
  const characters = characterEntries.map(([source, raw]) => {
    const config = parseCharacter(raw, source, registry);
    uniqueId(config.characterId, characterIds, config.source, "$.characterId");
    const metadata = runtimeCharacter(runtime, config);
    validateCharacterReferences(config, metadata, formatIds, commonSituationIds);
    return normalizeCharacter(config, metadata, defaults.commonSituations, defaultsSource);
  }).sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const characterOrders = new Set<number>();
  characters.forEach((character) => {
    if (characterOrders.has(character.order)) {
      fail(character.source, "$.order", `duplicate character order ${character.order}`);
    }
    characterOrders.add(character.order);
  });

  const formats: PromptFormat[] = defaults.basePresets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    subjectTags: {
      female: [...preset.subjectTags.female],
      male: [...preset.subjectTags.male],
    },
    tags: [...preset.tags],
    instructions: [...preset.instructions],
    source: defaultsSource,
  }));

  return {
    schemaVersion: defaults.schemaVersion,
    settings: {
      model: defaults.model,
      qualityTags: defaults.settings.qualityTags,
      ucPreset: defaults.settings.ucPreset,
      guidance: defaults.settings.guidance,
      steps: defaults.settings.steps,
      samplers: [...defaults.settings.samplers],
      variety: defaults.settings.variety,
      noiseSchedule: defaults.settings.noiseSchedule,
      promptGuidanceRescale: defaults.settings.promptGuidanceRescale,
    },
    formats,
    commonSituations: defaults.commonSituations.map((situation) => (
      normalizeSituation(situation, defaultsSource)
    )),
    characters,
    styleTags: [...defaults.styleTags],
    styleInstructions: [...defaults.styleInstructions],
    manualQualityTags: [...defaults.manualQualityTags],
    sharedUndesiredTags: [...defaults.sharedUndesiredTags],
    sharedUndesiredInstructions: [...defaults.sharedUndesiredInstructions],
    tagRegistry: registry,
    source: defaultsSource,
  };
}

export function loadPromptCatalog(): PromptCatalog {
  return parsePromptCatalog(
    { defaults: rawDefaults, characters: rawCharacters, registry: rawRegistry },
    runtimeJson as unknown as PromptRuntimeMetadata,
  );
}
