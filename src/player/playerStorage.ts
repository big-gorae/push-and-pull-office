import { normalizePlayerSession, type PlayerSession } from "./playerRuntime";
import type { GameLocale } from "./gameI18n";
import { resolveDialogueNode } from "../storyLogic";
import type { GameModeId, Runtime, ViewLayer } from "../types";

export type PlayerSettings = {
  textSpeed: number;
  autoDelay: number;
  reducedMotion: boolean;
  debugMode: boolean;
  characterX: number;
  characterY: number;
  characterScale: number;
  locale: GameLocale;
};

export type SaveSlot = {
  schema_version: 5;
  savedAt: number;
  preview: {
    kind: "timeline" | "scene" | "self_development" | "ending";
    day: number;
    slot: string;
    eventId?: string;
    sceneId?: string;
    nodeId?: string;
    variantId?: string;
    gameModeId: GameModeId;
    campaignId: string;
    continuityId: string;
    viewLayer: ViewLayer;
    endingId?: string;
  };
  session: PlayerSession;
};

export type ReadableSaveSlot = SaveSlot & {
  /** Read-only compatibility data. New writes never include localized strings. */
  legacy?: { sceneTitle?: string; line?: string };
};

export type PlayerProfile = {
  clearedRoutes: string[];
  unlockedModes: string[];
  memories: string[];
};

const PREFIX = "love-office:web-player";
const AUTOSAVE_KEY = `${PREFIX}:autosave`;
const SETTINGS_KEY = `${PREFIX}:settings`;
const PROFILE_KEY = `${PREFIX}:profile`;

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  textSpeed: 28,
  autoDelay: 1500,
  reducedMotion: false,
  debugMode: false,
  characterX: -8,
  characterY: 8,
  characterScale: 108,
  locale: "ko",
};

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

export function normalizePlayerSettings(
  stored: Partial<PlayerSettings> | undefined,
  supportedLocales: string[] = ["ko"],
  defaultLocale = "ko",
): PlayerSettings {
  const locale = stored?.locale && supportedLocales.includes(stored.locale) ? stored.locale : defaultLocale;
  return {
    ...DEFAULT_PLAYER_SETTINGS,
    ...stored,
    textSpeed: clamp(stored?.textSpeed, 8, 55, DEFAULT_PLAYER_SETTINGS.textSpeed),
    autoDelay: clamp(stored?.autoDelay, 600, 3500, DEFAULT_PLAYER_SETTINGS.autoDelay),
    characterX: clamp(stored?.characterX, -24, 24, DEFAULT_PLAYER_SETTINGS.characterX),
    characterY: clamp(stored?.characterY, -8, 24, DEFAULT_PLAYER_SETTINGS.characterY),
    characterScale: clamp(stored?.characterScale, 75, 135, DEFAULT_PLAYER_SETTINGS.characterScale),
    debugMode: stored?.debugMode === true,
    reducedMotion: stored?.reducedMotion === true,
    locale,
  };
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The player remains usable when storage is blocked or full.
  }
}

export function readSettings(supportedLocales: string[] = ["ko"], defaultLocale = "ko"): PlayerSettings {
  const stored = readJson<Partial<PlayerSettings>>(SETTINGS_KEY);
  return normalizePlayerSettings(stored, supportedLocales, defaultLocale);
}

export function writeSettings(settings: PlayerSettings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function readAutosave(runtime?: Runtime): ReadableSaveSlot | undefined {
  const slot = readJson<unknown>(AUTOSAVE_KEY);
  return slot ? normalizeSaveSlot(slot, runtime) : undefined;
}

export function writeAutosave(slot: SaveSlot): void {
  writeJson(AUTOSAVE_KEY, slot);
  writeProfileFromSession(slot.session);
}

export function readSlots(runtime?: Runtime): Array<ReadableSaveSlot | undefined> {
  return Array.from({ length: 8 }, (_, index) => {
    const slot = readJson<unknown>(`${PREFIX}:slot:${index}`);
    return slot ? normalizeSaveSlot(slot, runtime) : undefined;
  });
}

type LegacySaveSlot = Partial<ReadableSaveSlot> & {
  schema_version?: number;
  sceneId?: string;
  nodeId?: string;
  eventId?: string;
  variantId?: string;
  sceneTitle?: string;
  line?: string;
  session?: PlayerSession;
};

export function normalizeSaveSlot(value: unknown, runtime?: Runtime): ReadableSaveSlot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const slot = value as LegacySaveSlot;
  if (typeof slot.schema_version === "number" && slot.schema_version > 5) return undefined;
  if (!slot.session || typeof slot.savedAt !== "number") return undefined;
  let session: PlayerSession;
  try {
    session = normalizePlayerSession(slot.session, runtime);
  } catch {
    // Keep the original localStorage record untouched so it can be recovered or exported later.
    return undefined;
  }
  const existing = slot.preview;
  const sceneId = existing?.sceneId || slot.sceneId || session.sceneId;
  const nodeId = existing?.nodeId || slot.nodeId || session.nodeId;
  let variantId = existing?.variantId || slot.variantId;
  if (!variantId && runtime && session.phase === "scene") {
    const node = runtime.scenes[sceneId]?.nodes[nodeId];
    if (node && (node.kind === "dual_dialogue" || node.kind === "dual_narration")) {
      variantId = resolveDialogueNode(runtime, session.state, node).variantId;
    }
  }
  const lastTimelineEvent = [...session.timelineLog].reverse().find((entry) => entry.status === "seen");
  const preview = {
    kind: existing?.kind || (session.phase === "complete" ? "ending" : session.phase),
    day: existing?.day ?? session.state.progress.time.day,
    slot: existing?.slot || session.state.progress.time.slot,
    eventId: existing?.eventId || slot.eventId || session.currentEventId || lastTimelineEvent?.eventId,
    sceneId,
    nodeId,
    variantId,
    gameModeId: session.gameModeId,
    campaignId: session.campaignId,
    continuityId: session.continuityId,
    viewLayer: session.viewLayer,
    endingId: existing?.endingId || session.endingId,
  } satisfies SaveSlot["preview"];
  const legacy = slot.legacy || (slot.sceneTitle || slot.line
    ? { sceneTitle: slot.sceneTitle, line: slot.line }
    : undefined);
  return {
    schema_version: 5,
    savedAt: slot.savedAt,
    preview,
    session,
    ...(legacy ? { legacy } : {}),
  };
}

export function writeSlot(index: number, slot: SaveSlot): void {
  writeJson(`${PREFIX}:slot:${index}`, slot);
  writeProfileFromSession(slot.session);
}

export function readProfile(): PlayerProfile {
  return normalizePlayerProfile(readJson<Partial<PlayerProfile>>(PROFILE_KEY));
}

export function normalizePlayerProfile(stored: Partial<PlayerProfile> | undefined): PlayerProfile {
  const profile: PlayerProfile = {
    clearedRoutes: [],
    unlockedModes: ["base"],
    memories: [],
    ...stored,
  };
  profile.clearedRoutes = Array.from(new Set(profile.clearedRoutes));
  profile.memories = Array.from(new Set(profile.memories));
  profile.unlockedModes = Array.from(new Set([
    "base",
    ...profile.unlockedModes,
  ]));
  return profile;
}

export function writeProfileFromSession(session: PlayerSession): void {
  const existing = readProfile();
  writeJson(PROFILE_KEY, {
    clearedRoutes: Array.from(new Set([...existing.clearedRoutes, ...session.state.progress.cleared_routes])),
    unlockedModes: Array.from(new Set([...existing.unlockedModes, ...session.state.progress.unlocked_modes])),
    memories: Array.from(new Set([...existing.memories, ...session.state.progress.memories])),
  } satisfies PlayerProfile);
}
