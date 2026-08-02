import type {
  ComposedPrompt,
  PromptCatalog,
  PromptCharacter,
  PromptFormat,
  PromptItem,
  PromptSelection,
  PromptSituation,
  PromptVariant,
} from "./types";

export function exactDedupe(items: readonly PromptItem[]): PromptItem[] {
  const seen = new Set<string>();
  const result: PromptItem[] = [];
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Splits user-entered comma/newline tags while treating NovelAI numeric
 * emphasis blocks as one item. Config arrays do not pass through this helper:
 * every JSON array entry is already an atomic prompt item.
 */
export function splitPromptText(value: string): PromptItem[] {
  const items: string[] = [];
  let current = "";
  let insideWeightedItem = false;

  const pushCurrent = () => {
    const item = current.trim();
    if (item) items.push(item);
    current = "";
  };

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === ":" && value[index + 1] === ":") {
      current += "::";
      insideWeightedItem = !insideWeightedItem;
      index += 1;
      continue;
    }
    if (!insideWeightedItem && (value[index] === "," || value[index] === "\n")) {
      pushCurrent();
      continue;
    }
    current += value[index];
  }
  pushCurrent();
  return exactDedupe(items);
}

export function renderPromptItems(items: readonly PromptItem[]): string {
  return exactDedupe(items).join(", ");
}

function selectedCharacter(catalog: PromptCatalog, id: string): PromptCharacter {
  const character = catalog.characters.find((item) => item.id === id);
  if (!character) throw new Error(`Unknown prompt character: ${id}`);
  return character;
}

function selectedVariant(character: PromptCharacter, id?: string): PromptVariant {
  const resolvedId = id || character.defaultVariantId;
  const variant = character.variants.find((item) => item.id === resolvedId);
  if (!variant) throw new Error(`Unknown look ${resolvedId} for ${character.id}`);
  return variant;
}

function selectedSituation(variant: PromptVariant, id?: string): PromptSituation {
  const resolvedId = id || variant.defaultSituationId;
  const situation = variant.situations.find((item) => item.id === resolvedId);
  if (!situation) throw new Error(`Unknown situation ${resolvedId} for look ${variant.id}`);
  return situation;
}

function selectedFormat(
  catalog: PromptCatalog,
  situation: PromptSituation,
  id?: string,
): PromptFormat {
  const resolvedId = id || situation.basePresetId || catalog.formats[0]?.id;
  const format = catalog.formats.find((item) => item.id === resolvedId);
  if (!format) throw new Error(`Unknown prompt format: ${resolvedId || "(none)"}`);
  return format;
}

function extraItems(value?: string | readonly PromptItem[]): PromptItem[] {
  if (!value) return [];
  return typeof value === "string" ? splitPromptText(value) : exactDedupe(value);
}

function isFullBodyFormat(format: PromptFormat): boolean {
  return format.tags.some((tag) => tag.trim() === "full body");
}

export function composePrompt(
  catalog: PromptCatalog,
  selection: PromptSelection,
): ComposedPrompt {
  const character = selectedCharacter(catalog, selection.characterId);
  const variant = selectedVariant(character, selection.variantId);
  const situation = selectedSituation(variant, selection.situationId);
  const format = selectedFormat(catalog, situation, selection.formatId);
  const outfitId = selection.outfitId || variant.defaultOutfitId;
  const outfit = variant.outfits.find((item) => item.id === outfitId);
  if (!outfit) throw new Error(`Unknown outfit ${outfitId} for look ${variant.id}`);

  const baseItems = [
    ...format.subjectTags[character.subject],
    ...format.tags,
    ...catalog.styleTags,
    ...(catalog.settings.qualityTags ? [] : catalog.manualQualityTags),
  ];
  const characterItems = [
    character.subject === "female" ? "girl" : "boy",
    ...variant.identityTags,
    ...outfit.tags,
    ...(isFullBodyFormat(format) ? variant.fullBodyOnlyTags : []),
    ...situation.tags,
    ...extraItems(selection.extraPrompt),
  ];
  const undesiredItems = [
    ...catalog.sharedUndesiredTags,
    ...variant.characterUndesiredTags,
    ...situation.undesiredTags,
    ...extraItems(selection.extraUc),
  ];

  const base = renderPromptItems(baseItems);
  const characterPrompt = renderPromptItems(characterItems);
  return {
    base,
    character: characterPrompt,
    combined: [base, characterPrompt].filter(Boolean).join(" | "),
    uc: renderPromptItems(undesiredItems),
  };
}
