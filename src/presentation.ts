import type {
  Layer,
  LocaleId,
  ResolvedBackground,
  ResolvedCharacterVisual,
  ResolvedStage,
  Runtime,
  Scene,
  StagePosition,
  StoryNode,
  ViewMode,
  VisualObject,
} from "./types";

/** Resolves translated copy while preserving the Korean authoring source as fallback. */
export class LocalizationService {
  readonly locale: LocaleId;

  constructor(private readonly runtime: Runtime, locale?: LocaleId) {
    const requested = locale || runtime.localization.default_locale;
    this.locale = runtime.localization.supported_locales.includes(requested)
      ? requested
      : runtime.localization.default_locale;
  }

  t(key: string, fallback = ""): string {
    return this.runtime.localization.catalogs[this.locale]?.[key]
      || this.runtime.localization.source_strings[key]
      || fallback
      || key;
  }

  isTranslated(key: string): boolean {
    return !this.runtime.localization.coverage[this.locale]?.missing.includes(key);
  }

  coverage() {
    return this.runtime.localization.coverage[this.locale];
  }
}

function layerFor(node: StoryNode | undefined, mode: ViewMode): Layer | undefined {
  return node?.[mode] as Layer | undefined;
}

function stagePositions(count: number): StagePosition[] {
  if (count <= 1) return ["center"];
  if (count === 2) return ["left", "right"];
  if (count === 3) return ["far_left", "center", "far_right"];
  return ["far_left", "left", "right", "far_right"];
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

  resolveCharacter(characterId: string, expression: string | undefined, position: StagePosition, speaker: boolean): ResolvedCharacterVisual | undefined {
    const visual = this.concrete("character").find((candidate) => candidate.character === characterId);
    if (!visual?.fallback_asset) return undefined;
    return {
      visual_id: visual.id,
      character: characterId,
      asset: (expression && visual.expression_assets?.[expression]) || visual.fallback_asset,
      expression,
      outfit: visual.default_outfit,
      pose: visual.default_pose,
      position,
      speaker,
      render_strategy: visual.render_strategy === "layered_sprite" ? "layered_sprite" : "flat_portrait",
    };
  }

  resolveStage(scene: Scene, nodeId: string, mode: ViewMode): ResolvedStage {
    const node = scene.nodes[nodeId];
    const layer = layerFor(node, mode);
    const positions = stagePositions(scene.cast.length);
    const characters = scene.cast.flatMap((characterId, index) => {
      const visual = this.resolveCharacter(
        characterId,
        node?.speaker === characterId ? layer?.expression : undefined,
        positions[Math.min(index, positions.length - 1)],
        node?.speaker === characterId,
      );
      return visual ? [visual] : [];
    });
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
