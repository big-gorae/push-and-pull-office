import type {
  Layer,
  LocaleId,
  ArtworkPosition,
  ResolvedBackground,
  ResolvedCharacterVisual,
  ResolvedStage,
  Runtime,
  Scene,
  StoryNode,
  StageCharacterCue,
  ViewMode,
  VisualObject,
} from "./types";
import { effectiveSpeaker } from "./storyLogic";
import { canRevealProtagonistArtwork, isProtagonistArtwork } from "./protagonistArtworkPolicy";

export type MessageVariables = Record<string, string | number>;

function interpolate(message: string, variables: MessageVariables): string {
  return message.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (_, key: string) =>
    String(variables[key] ?? `{{${key}}}`));
}

/** Resolves translated copy while preserving the Korean authoring source as fallback. */
export class LocalizationService {
  readonly locale: LocaleId;

  constructor(private readonly runtime: Runtime, locale?: LocaleId) {
    const requested = locale || runtime.localization.default_locale;
    this.locale = runtime.localization.supported_locales.includes(requested)
      ? requested
      : runtime.localization.default_locale;
  }

  t(key: string, fallbackOrVariables: string | MessageVariables = "", variables: MessageVariables = {}): string {
    const fallback = typeof fallbackOrVariables === "string" ? fallbackOrVariables : "";
    const resolvedVariables = typeof fallbackOrVariables === "string" ? variables : fallbackOrVariables;
    const value = this.runtime.localization.resolved_catalogs?.[this.locale]?.[key]
      || this.runtime.localization.catalogs[this.locale]?.[key]
      || this.runtime.localization.source_strings[key]
      || fallback
      || key;
    return interpolate(value, resolvedVariables);
  }

  hasDirect(key: string): boolean {
    return this.locale === this.runtime.localization.default_locale
      ? Boolean(this.runtime.localization.entries?.[key])
      : Boolean(this.runtime.localization.direct_catalogs?.[this.locale]?.[key]);
  }

  entry(key: string) {
    return this.runtime.localization.entries?.[key];
  }

  isTranslated(key: string): boolean {
    return this.hasDirect(key);
  }

  coverage() {
    return this.runtime.localization.coverage[this.locale];
  }
}

function layerFor(node: StoryNode | undefined, mode: ViewMode): Layer | undefined {
  return node?.[mode] as Layer | undefined;
}

export type CharacterArtworkOption = {
  id: string;
  visual_id: string;
  character: string;
  asset: string;
  label: string;
  expression?: string;
};

function defaultArtworkId(visual: VisualObject): string | undefined {
  if (visual.default_artwork && visual.artworks?.[visual.default_artwork]) return visual.default_artwork;
  return Object.keys(visual.artworks || {})[0];
}

function artworkSelection(visual: VisualObject, artworkId: string | undefined, expression?: string) {
  const selectedId = artworkId === "default" || !artworkId ? defaultArtworkId(visual) : artworkId;
  const artwork = selectedId ? visual.artworks?.[selectedId] : undefined;
  if (artwork) {
    return {
      artwork: selectedId,
      asset: (expression && artwork.expression_assets?.[expression]) || artwork.asset,
      expression: expression && artwork.expression_assets?.[expression] ? expression : undefined,
    };
  }
  const legacyExpression = artworkId && artworkId !== "default" ? artworkId : expression;
  return {
    artwork: artworkId || "default",
    asset: (legacyExpression && visual.expression_assets?.[legacyExpression]) || visual.fallback_asset,
    expression: legacyExpression && visual.expression_assets?.[legacyExpression] ? legacyExpression : undefined,
  };
}

export function characterArtworkOptions(runtime: Runtime, characterId: string, mode?: ViewMode): CharacterArtworkOption[] {
  return Object.values(runtime.visuals)
    .filter((visual) => visual.kind === "character" && !visual.abstract && visual.character === characterId)
    .flatMap((visual): CharacterArtworkOption[] => {
      const artworks = Object.entries(visual.artworks || {}).map(([id, artwork]) => ({
        id,
        visual_id: visual.id,
        character: characterId,
        asset: artwork.asset,
        label: artwork.label || id.replaceAll("_", " "),
      }));
      if (artworks.length) return artworks;
      const fallback = visual.fallback_asset ? [{
        id: "default",
        visual_id: visual.id,
        character: characterId,
        asset: visual.fallback_asset,
        label: "기본 원화",
      }] : [];
      const expressions = Object.entries(visual.expression_assets || {})
        .filter(([expression]) => !mode || runtime.characters[characterId]?.expressions?.[expression]?.layer === mode)
        .map(([expression, asset]) => ({
          id: expression,
          visual_id: visual.id,
          character: characterId,
          asset,
          label: runtime.characters[characterId]?.expressions?.[expression]?.description || expression,
          expression,
        }));
      return [...fallback, ...expressions];
    });
}

/**
 * Data-driven presentation domain service.
 *
 * VisualObject is the polymorphic base object. Background and character
 * definitions share inheritance metadata but resolve through type-specific
 * strategies. Character rendering favors composition (outfit, pose,
 * expression) and falls back to a flat portrait until layered art exists.
 */
export class VisualResolver {
  constructor(private readonly runtime: Runtime) {}

  private concrete(kind: VisualObject["kind"]): VisualObject[] {
    return Object.values(this.runtime.visuals).filter((visual) => visual.kind === kind && !visual.abstract);
  }

  resolveBackground(scene: Scene, node: StoryNode | undefined, mode: ViewMode): ResolvedBackground | undefined {
    if (scene.default_background) {
      const visual = this.runtime.visuals[scene.default_background.visual_id];
      const variant = visual?.kind === "background" && !visual.abstract
        ? visual.variants?.[scene.default_background.variant_id]
        : undefined;
      if (visual && variant) {
        return {
          visual_id: visual.id,
          variant_id: scene.default_background.variant_id,
          asset: variant.asset,
          title_key: visual.title_key,
          defaults: visual.defaults || {},
          score: Number.MAX_SAFE_INTEGER,
          matched: ["scene-default"],
        };
      }
    }
    const layer = layerFor(node, mode);
    const dimensions: Record<string, string | undefined> = {
      locations: scene.location,
      times: scene.time,
      atmospheres: layer?.atmosphere,
      modes: mode,
    };
    const candidates: ResolvedBackground[] = [];
    this.concrete("background").forEach((visual) => {
      Object.entries(visual.variants || {}).forEach(([variantId, variant]) => {
        let score = variant.priority || 0;
        const matched: string[] = [];
        const rejected = Object.entries(dimensions).some(([dimension, actual]) => {
          const expected = variant.match?.[dimension as keyof typeof variant.match] as string[] | undefined;
          if (!expected?.length) return false;
          if (!actual || !expected.includes(actual)) return true;
          matched.push(`${dimension}:${actual}`);
          score += 5;
          return false;
        });
        if (!rejected) candidates.push({
          visual_id: visual.id,
          variant_id: variantId,
          asset: variant.asset,
          title_key: visual.title_key,
          defaults: visual.defaults || {},
          score,
          matched,
        });
      });
    });
    return candidates.sort((a, b) => b.score - a.score || a.visual_id.localeCompare(b.visual_id) || a.variant_id.localeCompare(b.variant_id))[0];
  }

  resolveCharacterCue(cue: StageCharacterCue, speakerId: string | null | undefined): ResolvedCharacterVisual | undefined {
    const visual = this.concrete("character").find((candidate) =>
      candidate.id === cue.visual_id && candidate.character === cue.character);
    if (!visual) return undefined;
    const selected = artworkSelection(visual, cue.artwork);
    if (!selected.asset) return undefined;
    return {
      visual_id: visual.id,
      character: cue.character,
      asset: selected.asset,
      expression: selected.expression,
      artwork: selected.artwork,
      outfit: visual.default_outfit,
      pose: visual.default_pose,
      position: cue.position as ArtworkPosition,
      speaker: speakerId === cue.character,
      render_strategy: visual.render_strategy === "layered_sprite" ? "layered_sprite" : "flat_portrait",
    };
  }

  resolveStage(scene: Scene, nodeId: string, mode: ViewMode, nodeOverride?: StoryNode): ResolvedStage {
    const node = nodeOverride || scene.nodes[nodeId];
    const speaker = effectiveSpeaker(node, mode);
    const protagonistReveal = canRevealProtagonistArtwork(scene, node);
    const hasManualStage = Boolean(node?.stage && Object.prototype.hasOwnProperty.call(node.stage, mode));
    const manualCues = hasManualStage ? node?.stage?.[mode] || [] : undefined;
    const characters = manualCues
      ? manualCues.flatMap((cue) => {
        if (isProtagonistArtwork(cue.character) && !protagonistReveal) return [];
        const visual = this.resolveCharacterCue(cue, speaker);
        return visual ? [visual] : [];
      })
      : [];
    return {
      background: this.resolveBackground(scene, node, mode),
      characters,
      mode,
      node: nodeId,
    };
  }
}

export function storyTextKey(sceneId: string, nodeId: string, suffix: string): string {
  return `scenes.${sceneId}.nodes.${nodeId}.${suffix}`;
}
