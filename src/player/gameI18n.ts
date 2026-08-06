import type { LocaleId, Runtime } from "../types";
import type { UiMessageKey } from "../generated/localizationKeys";
import { LocalizationService } from "../presentation";

export type GameLocale = LocaleId;
export type { UiMessageKey };
export type MessageVariables = Record<string, string | number>;

function interpolate(message: string, variables: MessageVariables): string {
  return message.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (_, key: string) =>
    String(variables[key] ?? `{{${key}}}`));
}

export function gameLocales(runtime: Runtime): LocaleId[] {
  const locales = runtime.localization.supported_locales;
  return locales.length ? locales : [runtime.localization.default_locale];
}

export class GameLocalizer {
  readonly locale: GameLocale;
  private readonly runtime: Runtime;
  private readonly service: LocalizationService;
  private readonly sourceOverrides: Readonly<Record<string, string>>;

  constructor(runtime: Runtime, locale?: GameLocale, sourceOverrides: Readonly<Record<string, string>> = {}) {
    this.runtime = runtime;
    const supported = gameLocales(runtime);
    this.locale = locale && supported.includes(locale)
      ? locale
      : runtime.localization.default_locale;
    this.service = new LocalizationService(runtime, this.locale);
    this.sourceOverrides = sourceOverrides;
  }

  private resolve(key: string, source?: string): string {
    const localizedOverride = this.sourceOverrides[`${this.locale}:${key}`];
    if (localizedOverride !== undefined) return localizedOverride;
    if (this.locale === this.runtime.localization.default_locale && key in this.sourceOverrides) {
      return this.sourceOverrides[key];
    }
    return this.service.t(key, source || key);
  }

  ui(key: UiMessageKey, variables: MessageVariables = {}): string {
    return interpolate(this.resolve(key), variables);
  }

  story(key: string, source: string, variables: MessageVariables = {}): string {
    return interpolate(this.resolve(key, source), variables);
  }

  characterName(characterId?: string): string {
    if (!characterId) return "";
    const character = this.runtime.characters[characterId];
    if (character) {
      return this.story(`characters.${characterId}.display_name`, character.display_name || characterId);
    }
    const member = this.runtime.world?.entities[characterId];
    return this.story(`world.${characterId}.display_name`, member?.display_name || characterId);
  }

  localeName(locale: GameLocale): string {
    const document = this.runtime.localization.locales[locale];
    return document?.native_name
      || this.runtime.localization.locale_names[locale]?.native_name
      || this.resolve(`locale.${locale}`, document?.name || locale);
  }
}
