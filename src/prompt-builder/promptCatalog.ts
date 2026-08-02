import runtimeJson from "../../build/story-runtime.json";
import {
  PromptConfigValidationError,
  type PromptCatalog,
  type PromptCharacter,
  type PromptConfigIssue,
  type PromptFormat,
  type PromptLayer,
  type PromptRuntimeMetadata,
  type PromptSubject,
  type PromptVariant,
  type RawPromptFiles,
  type RuntimeCharacterMetadata,
} from "./types";

type JsonObject = Record<string, unknown>;

type DefaultsConfig = {
  schemaVersion: 1;
  model: string;
  settings: {
    qualityTags: boolean;
    ucPreset: string;
    guidance: string;
    steps: string;
    samplers: string[];
  };
  styleTags: string[];
  manualQualityTags: string[];
  sharedUndesiredTags: string[];
  basePresets: Array<{
    id: string;
    label: string;
    description: string;
    subjectTags: Record<PromptSubject, string[]>;
    tags: string[];
  }>;
};

type CharacterConfig = {
  schemaVersion: 1;
  characterId: string;
  order: number;
  subject: PromptSubject;
  accent: string;
  defaultLookId: string;
  looks: Array<{
    id: string;
    label: string;
    layer?: PromptLayer;
    identityTags: string[];
    outfitTags: string[];
    fullBodyOnlyTags: string[];
    characterUndesiredTags: string[];
    defaultSituationId: string;
    situations: Array<{
      id: string;
      label: string;
      description?: string;
      expressionId?: string;
      basePresetId: string;
      tags: string[];
      undesiredTags: string[];
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

function schemaVersionAt(value: unknown, source: string): 1 {
  if (value !== 1) return fail(source, "$.schemaVersion", "expected schema version 1");
  return 1;
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

function uniqueId(id: string, seen: Set<string>, source: string, path: string): void {
  if (seen.has(id)) fail(source, path, `duplicate id ${JSON.stringify(id)}`);
  seen.add(id);
}

function parseDefaults(raw: string, source: string): DefaultsConfig {
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
        female: stringArrayAt(subjectTags.female, source, `${path}.subjectTags.female`),
        male: stringArrayAt(subjectTags.male, source, `${path}.subjectTags.male`),
      },
      tags: stringArrayAt(preset.tags, source, `${path}.tags`),
    };
  });

  return {
    schemaVersion: schemaVersionAt(root.schemaVersion, source),
    model: stringAt(root.model, source, "$.model"),
    settings: {
      qualityTags: booleanAt(settings.qualityTags, source, "$.settings.qualityTags"),
      ucPreset: stringAt(settings.ucPreset, source, "$.settings.ucPreset"),
      guidance: stringAt(settings.guidance, source, "$.settings.guidance"),
      steps: stringAt(settings.steps, source, "$.settings.steps"),
      samplers: stringArrayAt(settings.samplers, source, "$.settings.samplers"),
    },
    styleTags: stringArrayAt(root.styleTags, source, "$.styleTags"),
    manualQualityTags: stringArrayAt(root.manualQualityTags, source, "$.manualQualityTags"),
    sharedUndesiredTags: stringArrayAt(root.sharedUndesiredTags, source, "$.sharedUndesiredTags"),
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

function parseCharacter(raw: string, source: string): SourcedCharacterConfig {
  const root = objectAt(parseJson(raw, source), source, "$");
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
        tags: stringArrayAt(situation.tags, source, `${path}.tags`),
        undesiredTags: situation.undesiredTags === undefined
          ? []
          : stringArrayAt(situation.undesiredTags, source, `${path}.undesiredTags`, { allowEmpty: true }),
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
      identityTags: stringArrayAt(look.identityTags, source, `${lookPath}.identityTags`),
      outfitTags: stringArrayAt(look.outfitTags, source, `${lookPath}.outfitTags`),
      fullBodyOnlyTags: look.fullBodyOnlyTags === undefined
        ? []
        : stringArrayAt(look.fullBodyOnlyTags, source, `${lookPath}.fullBodyOnlyTags`, { allowEmpty: true }),
      characterUndesiredTags: stringArrayAt(
        look.characterUndesiredTags,
        source,
        `${lookPath}.characterUndesiredTags`,
        { allowEmpty: true },
      ),
      defaultSituationId,
      situations,
    };
  });

  const defaultLookId = stringAt(root.defaultLookId, source, "$.defaultLookId");
  if (!lookIds.has(defaultLookId)) {
    fail(source, "$.defaultLookId", `unknown look id ${JSON.stringify(defaultLookId)}`);
  }

  return {
    schemaVersion: schemaVersionAt(root.schemaVersion, source),
    characterId: stringAt(root.characterId, source, "$.characterId"),
    order: numberAt(root.order, source, "$.order"),
    subject: promptSubjectAt(root.subject, source, "$.subject"),
    accent: stringAt(root.accent, source, "$.accent"),
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
): void {
  config.looks.forEach((look, lookIndex) => {
    look.situations.forEach((situation, situationIndex) => {
      const path = `$.looks[${lookIndex}].situations[${situationIndex}]`;
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

function normalizeVariant(config: SourcedCharacterConfig, look: CharacterConfig["looks"][number]): PromptVariant {
  return {
    id: look.id,
    label: look.label,
    layer: look.layer,
    identityTags: [...look.identityTags],
    defaultOutfitId: "default",
    outfits: [{ id: "default", label: "기본 의상", tags: [...look.outfitTags] }],
    fullBodyOnlyTags: [...look.fullBodyOnlyTags],
    characterUndesiredTags: [...look.characterUndesiredTags],
    defaultSituationId: look.defaultSituationId,
    situations: look.situations.map((situation) => ({
      id: situation.id,
      label: situation.label,
      description: situation.description,
      expressionId: situation.expressionId,
      basePresetId: situation.basePresetId,
      tags: [...situation.tags],
      undesiredTags: [...situation.undesiredTags],
      source: config.source,
    })),
    source: config.source,
  };
}

function normalizeCharacter(
  config: SourcedCharacterConfig,
  metadata: RuntimeCharacterMetadata,
): PromptCharacter {
  return {
    id: config.characterId,
    order: config.order,
    displayName: metadata.display_name,
    age: metadata.age,
    role: metadata.role,
    narrativeRole: metadata.narrative_role,
    conceptArt: metadata.visual?.concept_art,
    palette: [...(metadata.visual?.palette || [])],
    accent: config.accent,
    subject: config.subject,
    defaultVariantId: config.defaultLookId,
    variants: config.looks.map((look) => normalizeVariant(config, look)),
    source: config.source,
  };
}

export function parsePromptCatalog(
  files: RawPromptFiles,
  runtime: PromptRuntimeMetadata,
): PromptCatalog {
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
  const defaults = parseDefaults(defaultsRaw, defaultsSource);
  const formatIds = new Set(defaults.basePresets.map((preset) => preset.id));

  const characterEntries = Object.entries(files.characters)
    .sort(([left], [right]) => left.localeCompare(right));
  if (!characterEntries.length) {
    fail("prompt-config/novelai-v45/characters", "$", "expected at least one character file");
  }

  const characterIds = new Set<string>();
  const characters = characterEntries.map(([source, raw]) => {
    const config = parseCharacter(raw, source);
    uniqueId(config.characterId, characterIds, config.source, "$.characterId");
    const metadata = runtimeCharacter(runtime, config);
    validateCharacterReferences(config, metadata, formatIds);
    return normalizeCharacter(config, metadata);
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
    },
    formats,
    characters,
    styleTags: [...defaults.styleTags],
    manualQualityTags: [...defaults.manualQualityTags],
    sharedUndesiredTags: [...defaults.sharedUndesiredTags],
    source: defaultsSource,
  };
}

export function loadPromptCatalog(): PromptCatalog {
  return parsePromptCatalog(
    { defaults: rawDefaults, characters: rawCharacters },
    runtimeJson as unknown as PromptRuntimeMetadata,
  );
}
