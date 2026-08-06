import type {
  ComposedPrompt,
  PromptCatalog,
  PromptCharacter,
  PromptFormat,
  PromptInstruction,
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

export function promptTagNames(item: PromptItem): PromptItem[] {
  const normalized = item.trim();
  const weighted = normalized.match(/^(-?(?:\d+(?:\.\d+)?))::([\s\S]+)::$/);
  if (normalized.includes("::") && !weighted) {
    throw new Error(`잘못된 NovelAI 강조 구문입니다: ${normalized}`);
  }
  return (weighted ? weighted[2] : normalized)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function instructionItems(value?: string | readonly PromptInstruction[]): PromptInstruction[] {
  if (!value) return [];
  const values = typeof value === "string" ? value.split(/\r?\n/) : value;
  return exactDedupe(values.map((item) => {
    const trimmed = item.trim();
    if (!trimmed) return "";
    const capitalized = `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
    return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
  }));
}

export function unregisteredPromptTags(
  catalog: PromptCatalog,
  items: readonly PromptItem[],
): PromptItem[] {
  const registered = new Set(catalog.tagRegistry.tags.map(({ tag }) => tag));
  return exactDedupe(items.flatMap(promptTagNames).filter((tag) => !registered.has(tag)));
}

function checkedExtraItems(
  catalog: PromptCatalog,
  value?: string | readonly PromptItem[],
): PromptItem[] {
  const items = extraItems(value);
  const unknown = unregisteredPromptTags(catalog, items);
  if (unknown.length) {
    throw new Error(`출처가 검증되지 않은 태그입니다: ${unknown.join(", ")}`);
  }
  return items;
}

export function renderPromptSections(
  tags: readonly PromptItem[],
  instructions: readonly PromptInstruction[],
): string {
  return [renderPromptItems(tags), instructionItems(instructions).join(" ")]
    .filter(Boolean)
    .join(", ");
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

  const extraTagItems = checkedExtraItems(catalog, selection.extraTags ?? selection.extraPrompt);
  const extraUcTagItems = checkedExtraItems(catalog, selection.extraUcTags ?? selection.extraUc);
  const identityTagItems = situation.identityMode === "face_only"
    ? variant.faceOnlyIdentityTags
    : variant.identityTags;
  const identityInstructions = situation.identityMode === "face_only"
    ? variant.faceOnlyIdentityInstructions
    : variant.identityInstructions;
  const outfitTagItems = situation.includeOutfit ? outfit.tags : [];
  const outfitInstructions = situation.includeOutfit ? outfit.instructions : [];
  const includeFullBodyDetails = situation.includeOutfit && isFullBodyFormat(format);
  const baseTagItems = [
    ...format.subjectTags[character.subject],
    ...format.tags,
    ...(situation.useSharedStyle ? catalog.styleTags : []),
    ...(catalog.settings.qualityTags ? [] : catalog.manualQualityTags),
  ];
  const baseInstructions = [
    ...format.instructions,
    ...(situation.useSharedStyle ? catalog.styleInstructions : []),
  ];
  const characterTagItems = [
    character.subject === "female" ? "girl" : "boy",
    ...identityTagItems,
    ...outfitTagItems,
    ...(includeFullBodyDetails ? variant.fullBodyOnlyTags : []),
    ...situation.tags,
    ...extraTagItems,
  ];
  const characterInstructions = [
    ...identityInstructions,
    ...outfitInstructions,
    ...(includeFullBodyDetails ? variant.fullBodyOnlyInstructions : []),
    ...situation.instructions,
    ...instructionItems(selection.extraInstructions),
  ];
  const characterUndesiredTags = situation.identityMode === "face_only"
    ? variant.faceOnlyUndesiredTags
    : variant.characterUndesiredTags;
  const characterUndesiredInstructions = situation.identityMode === "face_only"
    ? variant.faceOnlyUndesiredInstructions
    : variant.characterUndesiredInstructions;
  const omittedCharacterUcTags = new Set(situation.omitCharacterUndesiredTags);
  const activeCharacterUndesiredTags = characterUndesiredTags.filter((item) => (
    promptTagNames(item).every((tag) => !omittedCharacterUcTags.has(tag))
  ));
  const undesiredTagItems = [
    ...catalog.sharedUndesiredTags,
    ...activeCharacterUndesiredTags,
    ...situation.undesiredTags,
    ...extraUcTagItems,
  ];
  const undesiredInstructions = [
    ...catalog.sharedUndesiredInstructions,
    ...characterUndesiredInstructions,
    ...situation.undesiredInstructions,
    ...instructionItems(selection.extraUcInstructions),
  ];

  const base = renderPromptSections(baseTagItems, baseInstructions);
  const characterPrompt = renderPromptSections(characterTagItems, characterInstructions);
  return {
    base,
    character: characterPrompt,
    combined: [base, characterPrompt].filter(Boolean).join(" | "),
    uc: renderPromptSections(undesiredTagItems, undesiredInstructions),
    audit: {
      positiveTagItems: exactDedupe([...baseTagItems, ...characterTagItems]),
      positiveInstructions: instructionItems([...baseInstructions, ...characterInstructions]),
      undesiredTagItems: exactDedupe(undesiredTagItems),
      undesiredInstructions: instructionItems(undesiredInstructions),
    },
  };
}
