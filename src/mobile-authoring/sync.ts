import runtimeJson from "../../build/story-runtime.json";
import type { LocalizationEntry, Runtime } from "../types";
import {
  markEventsUploaded,
  markSceneEventsUploaded,
  readCatalog,
  readQueuedEvents,
  readQueuedSceneEvents,
  reconcileServerChanges,
  reconcileServerSceneChanges,
  writeCatalog,
} from "./storage";
import type {
  MobileApplyResult,
  MobileCatalogEntry,
  MobileCatalogSnapshot,
  MobileSceneSyncReceipt,
  MobileSceneWorkspace,
  MobileSyncReceipt,
  ServerChange,
  ServerSceneChange,
} from "./types";

const runtime = runtimeJson as unknown as Runtime;
export const MOBILE_PROJECT_ID = runtime.project.id || "love_office_story_1";

export function isMacSyncBridge(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sceneHash(scene: Runtime["scenes"][string]): Promise<string> {
  return sha256(stableStringify(scene));
}

async function bundledWorkspace(): Promise<MobileSceneWorkspace> {
  const totalDays = Math.max(1, ...Object.values(runtime.campaigns).map((campaign) => campaign.total_days));
  const grouped = new Map<number, MobileSceneWorkspace["days"][number]["scenes"]>();
  const seen = new Set<string>();
  Object.values(runtime.events)
    .filter((event) => Boolean(event.scene && runtime.scenes[event.scene]))
    .sort((left, right) => {
      const dayDelta = left.window.days[0] - right.window.days[0];
      if (dayDelta) return dayDelta;
      const campaign = runtime.campaigns[left.campaign_id];
      const slots = new Map((campaign?.slots || []).map((slot, index) => [slot, index]));
      const slotDelta = (slots.get(left.window.slots[0]) ?? 999) - (slots.get(right.window.slots[0]) ?? 999);
      return slotDelta || (left.sequence ?? 999) - (right.sequence ?? 999) || right.priority - left.priority;
    })
    .forEach((event) => {
      if (!event.scene) return;
      const day = event.window.days[0];
      const identity = `${day}:${event.scene}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      const entries = grouped.get(day) || [];
      entries.push({
        sceneId: event.scene,
        eventId: event.id,
        eventTitle: event.title,
        slot: event.window.slots.join(" · "),
        endDay: event.window.days[1],
      });
      grouped.set(day, entries);
    });

  const artworks = Object.values(runtime.visuals)
    .filter((visual) => visual.kind === "character" && !visual.abstract && visual.character)
    .flatMap((visual) => {
      const characterId = visual.character!;
      const characterLabel = runtime.characters[characterId]?.display_name || characterId;
      const choices = Object.entries(visual.artworks || {}).map(([id, artwork]) => ({
        id,
        visualId: visual.id,
        characterId,
        characterLabel,
        label: artwork.label || id.replaceAll("_", " "),
        asset: artwork.asset,
      }));
      if (choices.length) return choices;
      return visual.fallback_asset ? [{
        id: "default",
        visualId: visual.id,
        characterId,
        characterLabel,
        label: "기본 원화",
        asset: visual.fallback_asset,
      }] : [];
    });
  const backgrounds = Object.values(runtime.visuals)
    .filter((visual) => visual.kind === "background" && !visual.abstract)
    .flatMap((visual) => Object.entries(visual.variants || {}).map(([variantId, variant]) => ({
      visualId: visual.id,
      variantId,
      title: visual.title || visual.id,
      details: [
        ...(variant.match?.locations || []),
        ...(variant.match?.times || []),
      ].join(" · ") || variantId,
      asset: variant.asset,
    })))
    .sort((left, right) => left.title.localeCompare(right.title, "ko") || left.variantId.localeCompare(right.variantId));

  const scenes = Object.fromEntries(await Promise.all(Object.values(runtime.scenes).map(async (scene) => {
    const illustrated = scene.cast.map((id) => ({
      id,
      label: runtime.characters[id]?.display_name || id,
      illustrated: true,
      expressions: Object.entries(runtime.characters[id]?.expressions || {}).map(([expressionId, expression]) => ({
        id: expressionId,
        label: expression.description || expressionId,
      })),
    }));
    const supporting = (scene.world_context?.participants || [])
      .filter((id) => runtime.world?.entities[id]?.presentation === "text_only")
      .map((id) => ({ id, label: runtime.world?.entities[id]?.display_name || id, illustrated: false }));
    const speakers = [...illustrated, ...supporting].filter((option, index, options) =>
      options.findIndex((candidate) => candidate.id === option.id) === index);
    return [scene.id, {
      revision: runtime.source_sha256,
      sceneHash: await sceneHash(scene),
      scene,
      speakers,
    }];
  })));

  return {
    schemaVersion: 1,
    days: Array.from({ length: totalDays }, (_, index) => ({ day: index + 1, scenes: grouped.get(index + 1) || [] })),
    scenes,
    artworks,
    backgrounds,
  };
}

function mobileEntry(key: string, entry: LocalizationEntry): Promise<MobileCatalogEntry | undefined> {
  const document = entry.sourceDocument;
  const fieldPath = document.fieldPath;
  const editable = (document.kind === "scene" || document.kind === "system_flow") && (
    /^(nodes\.[^.]+\.line)$/.test(fieldPath)
    || /^nodes\.[^.]+\.variants\.[^.]+\.line$/.test(fieldPath)
    || /^nodes\.[^.]+\.(?:prompt|stimulus)$/.test(fieldPath)
    || /^nodes\.[^.]+\.analysis_hints\.(?:pull|push|none)$/.test(fieldPath)
    || /^nodes\.[^.]+\.options\.[^.]+\.(?:label|interpretation|action)$/.test(fieldPath)
    || /^options\.[^.]+\.(?:label|description)$/.test(fieldPath)
  );
  if (!editable || !entry.source.trim()) return Promise.resolve(undefined);
  return sha256(entry.source).then((valueHash) => ({
    localizationKey: key,
    locale: runtime.localization.default_locale,
    value: entry.source,
    valueHash,
    domain: document.kind as "scene" | "system_flow",
    documentId: document.id,
    documentTitle: document.kind === "scene"
      ? runtime.scenes[document.id]?.title || document.id
      : runtime.system_flows?.[document.id]?.title || document.id,
    context: entry.context,
    maxLength: entry.maxLength,
    placeholders: entry.placeholders || [],
    multiline: entry.multiline,
    linkedLocalizationKeys: [],
  }));
}

export async function bundledCatalog(): Promise<MobileCatalogSnapshot> {
  const source = runtime.localization.entries || {};
  const entries = (await Promise.all(Object.entries(source).map(([key, entry]) => mobileEntry(key, entry))))
    .filter((entry): entry is MobileCatalogEntry => Boolean(entry))
    .sort((left, right) => left.localizationKey.localeCompare(right.localizationKey));
  const workspace = await bundledWorkspace();
  const generation = await sha256(`${entries.map((entry) => `${entry.localizationKey}\u0000${entry.valueHash}`).join("\n")}\n${stableStringify(workspace)}`);
  return {
    schemaVersion: 2,
    projectId: MOBILE_PROJECT_ID,
    projectTitle: runtime.project.title,
    defaultLocale: runtime.localization.default_locale,
    generation,
    updatedAt: __LOVE_OFFICE_BUILD_TIME__,
    entries,
    workspace,
  };
}

function catalogTime(snapshot: MobileCatalogSnapshot): number {
  const value = Date.parse(snapshot.updatedAt || "");
  return Number.isFinite(value) ? value : 0;
}

export function newestCatalog(
  ...snapshots: Array<MobileCatalogSnapshot | undefined>
): MobileCatalogSnapshot | undefined {
  return snapshots.filter((snapshot): snapshot is MobileCatalogSnapshot => Boolean(snapshot?.workspace))
    .reduce<MobileCatalogSnapshot | undefined>((current, candidate) => {
      if (!current) return candidate;
      return catalogTime(candidate) > catalogTime(current) ? candidate : current;
    }, undefined);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error?.message || `동기화 서버 응답 ${response.status}`);
  }
  return body as T;
}

async function uploadCatalog(snapshot: MobileCatalogSnapshot): Promise<string | undefined> {
  const result = await api<{ catalog: { updatedAt?: string } }>("/api/authoring/v1/catalog", {
    method: "POST",
    body: JSON.stringify(snapshot),
  });
  return result.catalog.updatedAt;
}

async function downloadCatalog(projectId: string): Promise<MobileCatalogSnapshot | undefined> {
  const result = await api<{ catalog: MobileCatalogSnapshot }>(
    `/api/authoring/v1/catalog?projectId=${encodeURIComponent(projectId)}`,
  );
  return result.catalog.workspace ? result.catalog : undefined;
}

async function serverChanges(projectId: string, status?: "pending"): Promise<ServerChange[]> {
  const suffix = status ? `&status=${status}` : "";
  const result = await api<{ changes: ServerChange[] }>(
    `/api/authoring/v1/changes?projectId=${encodeURIComponent(projectId)}${suffix}`,
  );
  return result.changes;
}

async function serverSceneChanges(projectId: string, status?: "pending"): Promise<ServerSceneChange[]> {
  const suffix = status ? `&status=${status}` : "";
  const result = await api<{ changes: ServerSceneChange[] }>(
    `/api/authoring/v1/scene-changes?projectId=${encodeURIComponent(projectId)}${suffix}`,
  );
  return result.changes;
}

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const api = await import("@tauri-apps/api/core");
  return api.invoke<T>(command, args);
}

async function syncMac(projectId: string): Promise<MobileCatalogSnapshot | undefined> {
  if (!isMacSyncBridge()) return undefined;
  const snapshot = await invoke<MobileCatalogSnapshot>("mobile_sync_snapshot");
  if (snapshot.projectId !== projectId) throw new Error("Mac과 모바일 프로젝트가 다릅니다.");
  await uploadCatalog(snapshot);
  const [pending, pendingScenes] = await Promise.all([
    serverChanges(projectId, "pending"),
    serverSceneChanges(projectId, "pending"),
  ]);
  const result = await invoke<MobileApplyResult>("apply_mobile_sync_changes", {
    changes: pending,
    sceneChanges: pendingScenes,
  });
  if (result.receipts.length) {
    await api("/api/authoring/v1/receipts", {
      method: "POST",
      body: JSON.stringify({ projectId, receipts: result.receipts satisfies MobileSyncReceipt[] }),
    });
  }
  if (result.sceneReceipts?.length) {
    await api("/api/authoring/v1/scene-receipts", {
      method: "POST",
      body: JSON.stringify({ projectId, receipts: result.sceneReceipts satisfies MobileSceneSyncReceipt[] }),
    });
  }
  const updatedAt = await uploadCatalog(result.snapshot);
  return { ...result.snapshot, updatedAt };
}

let inFlight: Promise<MobileCatalogSnapshot | undefined> | undefined;

export function synchronize(
  projectId = MOBILE_PROJECT_ID,
  bundledSnapshot?: MobileCatalogSnapshot,
): Promise<MobileCatalogSnapshot | undefined> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const macSnapshot = await syncMac(projectId);
    const [queued, queuedScenes] = await Promise.all([
      readQueuedEvents(projectId),
      readQueuedSceneEvents(projectId),
    ]);
    if (queued.length) {
      await api<{ accepted: string[] }>("/api/authoring/v1/changes", {
        method: "POST",
        body: JSON.stringify({ changes: queued.map(({ uploaded: _uploaded, ...change }) => change) }),
      });
      await markEventsUploaded(queued.map((event) => event.eventId));
    }
    if (queuedScenes.length) {
      await api<{ accepted: string[] }>("/api/authoring/v1/scene-changes", {
        method: "POST",
        body: JSON.stringify({ changes: queuedScenes.map(({ uploaded: _uploaded, ...change }) => change) }),
      });
      await markSceneEventsUploaded(queuedScenes.map((event) => event.eventId));
    }
    const localCatalog = await readCatalog(projectId);
    const [downloadedCatalog, changes, sceneChanges] = await Promise.all([
      macSnapshot ? Promise.resolve(macSnapshot) : downloadCatalog(projectId),
      serverChanges(projectId),
      serverSceneChanges(projectId),
    ]);
    const catalog = macSnapshot || newestCatalog(bundledSnapshot, localCatalog, downloadedCatalog);
    if (catalog) await writeCatalog(catalog);
    await reconcileServerChanges(projectId, changes);
    await reconcileServerSceneChanges(projectId, sceneChanges);
    return catalog;
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}
