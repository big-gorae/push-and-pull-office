import type { ArtworkPosition, Scene } from "../types";

export type MobileCatalogEntry = {
  localizationKey: string;
  locale: string;
  value: string;
  valueHash: string;
  domain: "scene" | "system_flow";
  documentId: string;
  documentTitle: string;
  context: {
    sceneId?: string;
    flowId?: string;
    nodeId?: string;
    variantId?: string;
    optionId?: string;
    speakerId?: string;
  };
  maxLength?: number | null;
  placeholders: string[];
  multiline: boolean;
  linkedLocalizationKeys?: string[];
};

export type MobileCatalogSnapshot = {
  schemaVersion: 1 | 2;
  projectId: string;
  projectTitle: string;
  defaultLocale: string;
  generation: string;
  updatedAt?: string | null;
  entries: MobileCatalogEntry[];
  workspace?: MobileSceneWorkspace;
};

export type MobileScheduledScene = {
  sceneId: string;
  eventId: string;
  eventTitle: string;
  slot: string;
  endDay: number;
};

export type MobileDayGroup = {
  day: number;
  scenes: MobileScheduledScene[];
};

export type MobileSpeakerOption = {
  id: string;
  label: string;
  illustrated: boolean;
  expressions?: Array<{ id: string; label: string }>;
};

export type MobileArtworkOption = {
  id: string;
  visualId: string;
  characterId: string;
  characterLabel: string;
  label: string;
  asset?: string;
};

export type MobileBackgroundOption = {
  visualId: string;
  variantId: string;
  title: string;
  details: string;
  asset?: string;
};

export type MobileSceneRecord = {
  revision: string;
  sceneHash: string;
  scene: Scene;
  speakers: MobileSpeakerOption[];
};

export type MobileSceneWorkspace = {
  schemaVersion: 1;
  days: MobileDayGroup[];
  scenes: Record<string, MobileSceneRecord>;
  artworks: MobileArtworkOption[];
  backgrounds: MobileBackgroundOption[];
};

export type MobileChangeStatus = "editing" | "queued" | "pending" | "applied" | "conflict" | "rejected";

export type MobileTextChange = {
  eventId: string;
  projectId: string;
  localizationKey: string;
  locale: string;
  baseValue: string;
  baseValueHash: string;
  nextValue: string;
  deviceId: string;
  clientCreatedAt: string;
};

export type StoredMobileDraft = {
  id: string;
  projectId: string;
  localizationKey: string;
  locale: string;
  baseValue: string;
  baseValueHash: string;
  nextValue: string;
  eventId?: string;
  status: MobileChangeStatus;
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
  updatedAt: string;
};

export type StoredOutboxEvent = MobileTextChange & {
  uploaded: boolean;
};

export type MobileSceneChange = {
  eventId: string;
  projectId: string;
  sceneId: string;
  baseSceneHash: string;
  nextSceneHash: string;
  baseScene: Scene;
  nextScene: Scene;
  deviceId: string;
  clientCreatedAt: string;
};

export type StoredSceneDraft = {
  id: string;
  projectId: string;
  sceneId: string;
  baseSceneHash: string;
  baseScene: Scene;
  nextScene: Scene;
  eventId?: string;
  status: MobileChangeStatus;
  reason?: string;
  currentScene?: Scene;
  currentSceneHash?: string;
  updatedAt: string;
};

export type StoredSceneOutboxEvent = MobileSceneChange & {
  uploaded: boolean;
};

export type ServerSceneChange = MobileSceneChange & {
  status: "pending" | "superseded" | "applied" | "conflict" | "rejected";
  serverCreatedAt: string;
  updatedAt: string;
  reason?: string;
  currentScene?: Scene;
  currentSceneHash?: string;
};

export type ServerChange = MobileTextChange & {
  status: "pending" | "superseded" | "applied" | "conflict" | "rejected";
  serverCreatedAt: string;
  updatedAt: string;
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
};

export type MobileSyncReceipt = {
  eventId: string;
  status: "applied" | "conflict" | "rejected";
  reason?: string;
  currentValue?: string;
  currentValueHash?: string;
};

export type MobileSceneSyncReceipt = {
  eventId: string;
  status: "applied" | "conflict" | "rejected";
  reason?: string;
  currentScene?: Scene;
  currentSceneHash?: string;
};

export type MobileApplyResult = {
  receipts: MobileSyncReceipt[];
  sceneReceipts?: MobileSceneSyncReceipt[];
  snapshot: MobileCatalogSnapshot;
};

export type MobileArtworkSelection = {
  position: ArtworkPosition;
};
