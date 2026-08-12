import type {
  MobileCatalogSnapshot,
  MobileSceneChange,
  MobileTextChange,
  ServerChange,
  ServerSceneChange,
  StoredMobileDraft,
  StoredOutboxEvent,
  StoredSceneDraft,
  StoredSceneOutboxEvent,
} from "./types";

const DATABASE_NAME = "love-office-mobile-authoring";
const DATABASE_VERSION = 2;
const MEMORY = {
  catalog: undefined as MobileCatalogSnapshot | undefined,
  drafts: new Map<string, StoredMobileDraft>(),
  outbox: new Map<string, StoredOutboxEvent>(),
  sceneDrafts: new Map<string, StoredSceneDraft>(),
  sceneOutbox: new Map<string, StoredSceneOutboxEvent>(),
  settings: new Map<string, string>(),
};

let databasePromise: Promise<IDBDatabase | undefined> | undefined;

function database(): Promise<IDBDatabase | undefined> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(undefined);
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("catalog")) db.createObjectStore("catalog", { keyPath: "projectId" });
      if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "eventId" });
      if (!db.objectStoreNames.contains("sceneDrafts")) db.createObjectStore("sceneDrafts", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sceneOutbox")) db.createObjectStore("sceneOutbox", { keyPath: "eventId" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
  return databasePromise;
}

async function get<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  }).catch(() => undefined);
}

async function all<T>(storeName: string): Promise<T[]> {
  const db = await database();
  if (!db) return [];
  return new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  }).catch(() => []);
}

async function put<T>(storeName: string, value: T): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function remove(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await database();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function draftId(projectId: string, localizationKey: string, locale: string): string {
  return `${projectId}\u0000${locale}\u0000${localizationKey}`;
}

export function sceneDraftId(projectId: string, sceneId: string): string {
  return `${projectId}\u0000scene\u0000${sceneId}`;
}

export async function readCatalog(projectId: string): Promise<MobileCatalogSnapshot | undefined> {
  const persisted = await get<MobileCatalogSnapshot>("catalog", projectId);
  return persisted || MEMORY.catalog;
}

export async function writeCatalog(snapshot: MobileCatalogSnapshot): Promise<void> {
  MEMORY.catalog = snapshot;
  await put("catalog", snapshot).catch(() => undefined);
}

export async function readDrafts(projectId: string): Promise<StoredMobileDraft[]> {
  const persisted = await all<StoredMobileDraft>("drafts");
  const values = persisted.length ? persisted : [...MEMORY.drafts.values()];
  return values.filter((draft) => draft.projectId === projectId);
}

export async function writeDraft(draft: StoredMobileDraft): Promise<void> {
  MEMORY.drafts.set(draft.id, draft);
  await put("drafts", draft).catch(() => undefined);
}

export async function deleteDraft(draft: StoredMobileDraft): Promise<void> {
  MEMORY.drafts.delete(draft.id);
  await remove("drafts", draft.id).catch(() => undefined);
  if (draft.eventId) {
    MEMORY.outbox.delete(draft.eventId);
    await remove("outbox", draft.eventId).catch(() => undefined);
  }
}

export async function queueChange(change: MobileTextChange): Promise<StoredMobileDraft> {
  const id = draftId(change.projectId, change.localizationKey, change.locale);
  const prior = await get<StoredMobileDraft>("drafts", id) || MEMORY.drafts.get(id);
  if (prior?.eventId) {
    MEMORY.outbox.delete(prior.eventId);
    await remove("outbox", prior.eventId).catch(() => undefined);
  }
  const outbox: StoredOutboxEvent = { ...change, uploaded: false };
  const draft: StoredMobileDraft = {
    id,
    projectId: change.projectId,
    localizationKey: change.localizationKey,
    locale: change.locale,
    baseValue: change.baseValue,
    baseValueHash: change.baseValueHash,
    nextValue: change.nextValue,
    eventId: change.eventId,
    status: "queued",
    updatedAt: change.clientCreatedAt,
  };
  MEMORY.outbox.set(change.eventId, outbox);
  MEMORY.drafts.set(id, draft);
  await Promise.all([
    put("outbox", outbox).catch(() => undefined),
    put("drafts", draft).catch(() => undefined),
  ]);
  return draft;
}

export async function readQueuedEvents(projectId: string): Promise<StoredOutboxEvent[]> {
  const persisted = await all<StoredOutboxEvent>("outbox");
  const values = persisted.length ? persisted : [...MEMORY.outbox.values()];
  return values.filter((event) => event.projectId === projectId && !event.uploaded);
}

export async function markEventsUploaded(eventIds: string[]): Promise<void> {
  await Promise.all(eventIds.map(async (eventId) => {
    const event = await get<StoredOutboxEvent>("outbox", eventId) || MEMORY.outbox.get(eventId);
    if (!event) return;
    const next = { ...event, uploaded: true };
    MEMORY.outbox.set(eventId, next);
    await put("outbox", next).catch(() => undefined);
    const id = draftId(event.projectId, event.localizationKey, event.locale);
    const draft = await get<StoredMobileDraft>("drafts", id) || MEMORY.drafts.get(id);
    if (draft?.eventId !== eventId) return;
    await writeDraft({ ...draft, status: "pending", updatedAt: new Date().toISOString() });
  }));
}

export async function reconcileServerChanges(projectId: string, changes: ServerChange[]): Promise<void> {
  const byEvent = new Map(changes.map((change) => [change.eventId, change]));
  const drafts = await readDrafts(projectId);
  await Promise.all(drafts.map(async (draft) => {
    if (!draft.eventId) return;
    const change = byEvent.get(draft.eventId);
    if (!change) return;
    if (change.status === "applied" || change.status === "superseded") {
      await deleteDraft(draft);
      return;
    }
    if (change.status === "pending") {
      await writeDraft({ ...draft, status: "pending", updatedAt: change.updatedAt });
      return;
    }
    await writeDraft({
      ...draft,
      status: change.status,
      reason: change.reason,
      currentValue: change.currentValue,
      currentValueHash: change.currentValueHash,
      updatedAt: change.updatedAt,
    });
  }));
}

export async function deviceId(): Promise<string> {
  const stored = await get<{ key: string; value: string }>("settings", "deviceId");
  if (stored?.value) return stored.value;
  const memory = MEMORY.settings.get("deviceId");
  if (memory) return memory;
  const value = crypto.randomUUID();
  MEMORY.settings.set("deviceId", value);
  await put("settings", { key: "deviceId", value }).catch(() => undefined);
  return value;
}

export async function readSceneDrafts(projectId: string): Promise<StoredSceneDraft[]> {
  const persisted = await all<StoredSceneDraft>("sceneDrafts");
  const values = persisted.length ? persisted : [...MEMORY.sceneDrafts.values()];
  return values.filter((draft) => draft.projectId === projectId);
}

export async function writeSceneDraft(draft: StoredSceneDraft): Promise<void> {
  MEMORY.sceneDrafts.set(draft.id, draft);
  await put("sceneDrafts", draft).catch(() => undefined);
}

export async function deleteSceneDraft(draft: StoredSceneDraft): Promise<void> {
  MEMORY.sceneDrafts.delete(draft.id);
  await remove("sceneDrafts", draft.id).catch(() => undefined);
  if (draft.eventId) {
    MEMORY.sceneOutbox.delete(draft.eventId);
    await remove("sceneOutbox", draft.eventId).catch(() => undefined);
  }
}

export async function queueSceneChange(change: MobileSceneChange): Promise<StoredSceneDraft> {
  const id = sceneDraftId(change.projectId, change.sceneId);
  const prior = await get<StoredSceneDraft>("sceneDrafts", id) || MEMORY.sceneDrafts.get(id);
  if (prior?.eventId) {
    MEMORY.sceneOutbox.delete(prior.eventId);
    await remove("sceneOutbox", prior.eventId).catch(() => undefined);
  }
  const outbox: StoredSceneOutboxEvent = { ...change, uploaded: false };
  const draft: StoredSceneDraft = {
    id,
    projectId: change.projectId,
    sceneId: change.sceneId,
    baseSceneHash: change.baseSceneHash,
    baseScene: change.baseScene,
    nextScene: change.nextScene,
    eventId: change.eventId,
    status: "queued",
    updatedAt: change.clientCreatedAt,
  };
  MEMORY.sceneOutbox.set(change.eventId, outbox);
  MEMORY.sceneDrafts.set(id, draft);
  await Promise.all([
    put("sceneOutbox", outbox).catch(() => undefined),
    put("sceneDrafts", draft).catch(() => undefined),
  ]);
  return draft;
}

export async function readQueuedSceneEvents(projectId: string): Promise<StoredSceneOutboxEvent[]> {
  const persisted = await all<StoredSceneOutboxEvent>("sceneOutbox");
  const values = persisted.length ? persisted : [...MEMORY.sceneOutbox.values()];
  return values.filter((event) => event.projectId === projectId && !event.uploaded);
}

export async function markSceneEventsUploaded(eventIds: string[]): Promise<void> {
  await Promise.all(eventIds.map(async (eventId) => {
    const event = await get<StoredSceneOutboxEvent>("sceneOutbox", eventId) || MEMORY.sceneOutbox.get(eventId);
    if (!event) return;
    const next = { ...event, uploaded: true };
    MEMORY.sceneOutbox.set(eventId, next);
    await put("sceneOutbox", next).catch(() => undefined);
    const id = sceneDraftId(event.projectId, event.sceneId);
    const draft = await get<StoredSceneDraft>("sceneDrafts", id) || MEMORY.sceneDrafts.get(id);
    if (draft?.eventId !== eventId) return;
    await writeSceneDraft({ ...draft, status: "pending", updatedAt: new Date().toISOString() });
  }));
}

export async function reconcileServerSceneChanges(projectId: string, changes: ServerSceneChange[]): Promise<void> {
  const byEvent = new Map(changes.map((change) => [change.eventId, change]));
  const drafts = await readSceneDrafts(projectId);
  await Promise.all(drafts.map(async (draft) => {
    if (!draft.eventId) return;
    const change = byEvent.get(draft.eventId);
    if (!change) return;
    if (change.status === "applied" || change.status === "superseded") {
      await deleteSceneDraft(draft);
      return;
    }
    if (change.status === "pending") {
      await writeSceneDraft({ ...draft, status: "pending", updatedAt: change.updatedAt });
      return;
    }
    await writeSceneDraft({
      ...draft,
      status: change.status,
      reason: change.reason,
      currentScene: change.currentScene,
      currentSceneHash: change.currentSceneHash,
      updatedAt: change.updatedAt,
    });
  }));
}
