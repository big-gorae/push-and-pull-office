import runtimeJson from "../../build/story-runtime.json";
import type { LocalizationEntry, Runtime } from "../types";
import {
  markEventsUploaded,
  readQueuedEvents,
  reconcileServerChanges,
  writeCatalog,
} from "./storage";
import type {
  MobileApplyResult,
  MobileCatalogEntry,
  MobileCatalogSnapshot,
  MobileSyncReceipt,
  ServerChange,
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

function mobileEntry(key: string, entry: LocalizationEntry, all: Record<string, LocalizationEntry>): Promise<MobileCatalogEntry | undefined> {
  const document = entry.sourceDocument;
  const fieldPath = document.fieldPath;
  const editable = (document.kind === "scene" || document.kind === "system_flow") && (
    /^(nodes\.[^.]+\.(?:perceived|reality)\.line)$/.test(fieldPath)
    || /^nodes\.[^.]+\.variants\.[^.]+\.(?:perceived|reality)\.line$/.test(fieldPath)
    || /^nodes\.[^.]+\.(?:prompt|stimulus)$/.test(fieldPath)
    || /^nodes\.[^.]+\.analysis_hints\.(?:pull|push|none)$/.test(fieldPath)
    || /^nodes\.[^.]+\.options\.[^.]+\.(?:label|interpretation|action)$/.test(fieldPath)
    || /^options\.[^.]+\.(?:label|description)$/.test(fieldPath)
  );
  if (!editable || !entry.source.trim()) return Promise.resolve(undefined);
  const counterpart = key.includes(".perceived.line")
    ? key.replace(".perceived.line", ".reality.line")
    : key.replace(".reality.line", ".perceived.line");
  const linked = counterpart !== key && all[counterpart]?.source === entry.source ? [counterpart] : [];
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
    linkedLocalizationKeys: linked,
  }));
}

export async function bundledCatalog(): Promise<MobileCatalogSnapshot> {
  const source = runtime.localization.entries || {};
  const entries = (await Promise.all(Object.entries(source).map(([key, entry]) => mobileEntry(key, entry, source))))
    .filter((entry): entry is MobileCatalogEntry => Boolean(entry))
    .sort((left, right) => left.localizationKey.localeCompare(right.localizationKey));
  const generation = await sha256(entries.map((entry) => `${entry.localizationKey}\u0000${entry.valueHash}`).join("\n"));
  return {
    schemaVersion: 1,
    projectId: MOBILE_PROJECT_ID,
    projectTitle: runtime.project.title,
    defaultLocale: runtime.localization.default_locale,
    generation,
    entries,
  };
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

async function uploadCatalog(snapshot: MobileCatalogSnapshot): Promise<void> {
  await api("/api/authoring/v1/catalog", {
    method: "POST",
    body: JSON.stringify(snapshot),
  });
}

async function downloadCatalog(projectId: string): Promise<MobileCatalogSnapshot | undefined> {
  const result = await api<{ catalog: MobileCatalogSnapshot }>(
    `/api/authoring/v1/catalog?projectId=${encodeURIComponent(projectId)}`,
  );
  return result.catalog.entries.length ? result.catalog : undefined;
}

async function serverChanges(projectId: string, status?: "pending"): Promise<ServerChange[]> {
  const suffix = status ? `&status=${status}` : "";
  const result = await api<{ changes: ServerChange[] }>(
    `/api/authoring/v1/changes?projectId=${encodeURIComponent(projectId)}${suffix}`,
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
  const pending = await serverChanges(projectId, "pending");
  if (!pending.length) return snapshot;
  const result = await invoke<MobileApplyResult>("apply_mobile_sync_changes", { changes: pending });
  if (result.receipts.length) {
    await api("/api/authoring/v1/receipts", {
      method: "POST",
      body: JSON.stringify({ projectId, receipts: result.receipts satisfies MobileSyncReceipt[] }),
    });
  }
  await uploadCatalog(result.snapshot);
  return result.snapshot;
}

let inFlight: Promise<MobileCatalogSnapshot | undefined> | undefined;

export function synchronize(projectId = MOBILE_PROJECT_ID): Promise<MobileCatalogSnapshot | undefined> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const macSnapshot = await syncMac(projectId);
    const queued = await readQueuedEvents(projectId);
    if (queued.length) {
      await api<{ accepted: string[] }>("/api/authoring/v1/changes", {
        method: "POST",
        body: JSON.stringify({ changes: queued.map(({ uploaded: _uploaded, ...change }) => change) }),
      });
      await markEventsUploaded(queued.map((event) => event.eventId));
    }
    const [catalog, changes] = await Promise.all([
      macSnapshot ? Promise.resolve(macSnapshot) : downloadCatalog(projectId),
      serverChanges(projectId),
    ]);
    if (catalog) await writeCatalog(catalog);
    await reconcileServerChanges(projectId, changes);
    return catalog;
  })().finally(() => { inFlight = undefined; });
  return inFlight;
}
