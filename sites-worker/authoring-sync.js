const API_PREFIX = "/api/authoring/v1/";
const MAX_JSON_BYTES = 1_500_000;
const MAX_CATALOG_ENTRIES = 2_000;
const MAX_CHANGE_BATCH = 100;
const MAX_SCENE_CHANGE_BATCH = 10;
const MAX_TEXT_LENGTH = 4_000;
const MAX_SCENE_JSON_BYTES = 250_000;
const MAX_WORKSPACE_JSON_BYTES = 900_000;
const EVENT_ID = /^[a-zA-Z0-9_-]{16,96}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[a-z][a-z0-9_.-]{1,127}$/;
const LOCALIZATION_KEY = /^[a-zA-Z0-9_.-]{2,500}$/;
const SCENE_ID = /^[a-zA-Z0-9_.-]{2,256}$/;
const TERMINAL_STATUSES = new Set(["applied", "conflict", "rejected"]);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS authoring_catalog (
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    localization_key TEXT NOT NULL,
    locale TEXT NOT NULL,
    value TEXT NOT NULL,
    value_hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    generation TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id, localization_key, locale)
  )`,
  `CREATE TABLE IF NOT EXISTS authoring_changes (
    owner_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    localization_key TEXT NOT NULL,
    locale TEXT NOT NULL,
    base_value TEXT NOT NULL,
    base_value_hash TEXT NOT NULL,
    next_value TEXT NOT NULL,
    device_id TEXT NOT NULL,
    client_created_at TEXT NOT NULL,
    server_created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'superseded', 'applied', 'conflict', 'rejected')),
    reason TEXT,
    current_value TEXT,
    current_value_hash TEXT,
    PRIMARY KEY (owner_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_authoring_changes_pending
    ON authoring_changes (owner_id, project_id, status, server_created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_authoring_changes_key
    ON authoring_changes (owner_id, project_id, localization_key, locale, status)`,
  `CREATE INDEX IF NOT EXISTS idx_authoring_catalog_generation
    ON authoring_catalog (owner_id, project_id, generation)`,
  `CREATE TABLE IF NOT EXISTS authoring_workspace (
    owner_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    project_title TEXT NOT NULL,
    default_locale TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    generation TEXT NOT NULL,
    workspace_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS authoring_scene_changes (
    owner_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    scene_id TEXT NOT NULL,
    base_scene_hash TEXT NOT NULL,
    next_scene_hash TEXT NOT NULL,
    base_scene_json TEXT NOT NULL,
    next_scene_json TEXT NOT NULL,
    device_id TEXT NOT NULL,
    client_created_at TEXT NOT NULL,
    server_created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'superseded', 'applied', 'conflict', 'rejected')),
    reason TEXT,
    current_scene_json TEXT,
    current_scene_hash TEXT,
    PRIMARY KEY (owner_id, event_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_authoring_scene_changes_pending
    ON authoring_scene_changes (owner_id, project_id, status, server_created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_authoring_scene_changes_scene
    ON authoring_scene_changes (owner_id, project_id, scene_id, status)`,
];

let schemaReady;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    },
  });
}

function error(code, message, status = 400) {
  return response({ ok: false, error: { code, message } }, status);
}

function isLocalRequest(url) {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost";
}

function ownerId(request, url) {
  const value = request.headers.get("oai-authenticated-user-id")?.trim();
  if (value) return value;
  return isLocalRequest(url) ? "local-development-user" : undefined;
}

function sameOriginWrite(request, url) {
  const origin = request.headers.get("origin");
  return origin === url.origin || (!origin && isLocalRequest(url));
}

async function readJson(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("JSON 요청만 허용됩니다."), { status: 415, code: "JSON_REQUIRED" });
  }
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > MAX_JSON_BYTES) {
    throw Object.assign(new Error("요청이 너무 큽니다."), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw Object.assign(new Error("요청이 너무 큽니다."), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("JSON 형식이 올바르지 않습니다."), { status: 400, code: "INVALID_JSON" });
  }
}

async function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((sql) => db.prepare(sql))).catch((failure) => {
      schemaReady = undefined;
      throw failure;
    });
  }
  await schemaReady;
}

function requireString(value, name, maxLength = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw Object.assign(new Error(`${name} 값이 올바르지 않습니다.`), { code: "INVALID_FIELD" });
  }
  return value;
}

function validateProjectId(value) {
  const projectId = requireString(value, "projectId", 128);
  if (!PROJECT_ID.test(projectId)) throw Object.assign(new Error("projectId 형식이 올바르지 않습니다."), { code: "INVALID_PROJECT" });
  return projectId;
}

function validateCatalogEntry(raw) {
  const localizationKey = requireString(raw?.localizationKey, "localizationKey", 500);
  const locale = requireString(raw?.locale, "locale", 16);
  const value = requireString(raw?.value, "value", MAX_TEXT_LENGTH);
  const valueHash = requireString(raw?.valueHash, "valueHash", 64);
  if (!LOCALIZATION_KEY.test(localizationKey) || !SHA256.test(valueHash)) {
    throw Object.assign(new Error("카탈로그 키 또는 hash가 올바르지 않습니다."), { code: "INVALID_CATALOG" });
  }
  const metadata = {
    domain: raw.domain === "system_flow" ? "system_flow" : "scene",
    documentId: typeof raw.documentId === "string" ? raw.documentId.slice(0, 256) : "",
    documentTitle: typeof raw.documentTitle === "string" ? raw.documentTitle.slice(0, 500) : "",
    context: raw.context && typeof raw.context === "object" ? raw.context : {},
    maxLength: Number.isInteger(raw.maxLength) ? raw.maxLength : null,
    placeholders: Array.isArray(raw.placeholders) ? raw.placeholders.filter((item) => typeof item === "string").slice(0, 32) : [],
    multiline: Boolean(raw.multiline),
    linkedLocalizationKeys: Array.isArray(raw.linkedLocalizationKeys)
      ? raw.linkedLocalizationKeys.filter((item) => typeof item === "string" && LOCALIZATION_KEY.test(item)).slice(0, 4)
      : [],
  };
  return { localizationKey, locale, value, valueHash, metadata };
}

function validateWorkspace(raw) {
  if (!raw || typeof raw !== "object" || raw.schemaVersion !== 1
    || !Array.isArray(raw.days) || !raw.scenes || typeof raw.scenes !== "object"
    || !Array.isArray(raw.artworks) || !Array.isArray(raw.backgrounds)) {
    throw Object.assign(new Error("장면 작업공간 payload가 올바르지 않습니다."), { code: "INVALID_WORKSPACE" });
  }
  const workspaceJson = JSON.stringify(raw);
  if (new TextEncoder().encode(workspaceJson).byteLength > MAX_WORKSPACE_JSON_BYTES) {
    throw Object.assign(new Error("장면 작업공간이 너무 큽니다."), { code: "WORKSPACE_TOO_LARGE", status: 413 });
  }
  return workspaceJson;
}

function validateChange(raw) {
  const eventId = requireString(raw?.eventId, "eventId", 96);
  const projectId = validateProjectId(raw?.projectId);
  const localizationKey = requireString(raw?.localizationKey, "localizationKey", 500);
  const locale = requireString(raw?.locale, "locale", 16);
  const baseValue = requireString(raw?.baseValue, "baseValue", MAX_TEXT_LENGTH);
  const baseValueHash = requireString(raw?.baseValueHash, "baseValueHash", 64);
  const nextValue = requireString(raw?.nextValue, "nextValue", MAX_TEXT_LENGTH);
  const deviceId = requireString(raw?.deviceId, "deviceId", 128);
  const clientCreatedAt = requireString(raw?.clientCreatedAt, "clientCreatedAt", 64);
  if (!EVENT_ID.test(eventId) || !LOCALIZATION_KEY.test(localizationKey) || !SHA256.test(baseValueHash)) {
    throw Object.assign(new Error("변경 이벤트 형식이 올바르지 않습니다."), { code: "INVALID_CHANGE" });
  }
  if (!Number.isFinite(Date.parse(clientCreatedAt))) {
    throw Object.assign(new Error("변경 이벤트 시간이 올바르지 않습니다."), { code: "INVALID_CHANGE_TIME" });
  }
  return { eventId, projectId, localizationKey, locale, baseValue, baseValueHash, nextValue, deviceId, clientCreatedAt };
}

function validateSceneChange(raw) {
  const eventId = requireString(raw?.eventId, "eventId", 96);
  const projectId = validateProjectId(raw?.projectId);
  const sceneId = requireString(raw?.sceneId, "sceneId", 256);
  const baseSceneHash = requireString(raw?.baseSceneHash, "baseSceneHash", 64);
  const nextSceneHash = requireString(raw?.nextSceneHash, "nextSceneHash", 64);
  const deviceId = requireString(raw?.deviceId, "deviceId", 128);
  const clientCreatedAt = requireString(raw?.clientCreatedAt, "clientCreatedAt", 64);
  if (!EVENT_ID.test(eventId) || !SCENE_ID.test(sceneId) || !SHA256.test(baseSceneHash) || !SHA256.test(nextSceneHash)) {
    throw Object.assign(new Error("장면 변경 이벤트 형식이 올바르지 않습니다."), { code: "INVALID_SCENE_CHANGE" });
  }
  if (!Number.isFinite(Date.parse(clientCreatedAt))) {
    throw Object.assign(new Error("장면 변경 이벤트 시간이 올바르지 않습니다."), { code: "INVALID_CHANGE_TIME" });
  }
  if (!raw.baseScene || typeof raw.baseScene !== "object" || raw.baseScene.id !== sceneId
    || !raw.nextScene || typeof raw.nextScene !== "object" || raw.nextScene.id !== sceneId) {
    throw Object.assign(new Error("장면 기준본 또는 수정본이 올바르지 않습니다."), { code: "INVALID_SCENE_DOCUMENT" });
  }
  const baseSceneJson = JSON.stringify(raw.baseScene);
  const nextSceneJson = JSON.stringify(raw.nextScene);
  if (new TextEncoder().encode(baseSceneJson).byteLength > MAX_SCENE_JSON_BYTES
    || new TextEncoder().encode(nextSceneJson).byteLength > MAX_SCENE_JSON_BYTES) {
    throw Object.assign(new Error("장면 변경 내용이 너무 큽니다."), { code: "SCENE_CHANGE_TOO_LARGE", status: 413 });
  }
  return {
    eventId, projectId, sceneId, baseSceneHash, nextSceneHash,
    baseSceneJson, nextSceneJson, deviceId, clientCreatedAt,
  };
}

async function putCatalog(db, owner, payload) {
  const projectId = validateProjectId(payload?.projectId);
  const generation = requireString(payload?.generation, "generation", 64);
  if (!SHA256.test(generation) || !Array.isArray(payload?.entries) || payload.entries.length > MAX_CATALOG_ENTRIES) {
    throw Object.assign(new Error("카탈로그 payload가 올바르지 않습니다."), { code: "INVALID_CATALOG" });
  }
  const entries = payload.entries.map(validateCatalogEntry);
  const workspaceJson = validateWorkspace(payload?.workspace);
  const projectTitle = typeof payload.projectTitle === "string" ? payload.projectTitle.slice(0, 500) : projectId;
  const defaultLocale = typeof payload.defaultLocale === "string" ? payload.defaultLocale.slice(0, 16) : "ko";
  const now = new Date().toISOString();
  for (let index = 0; index < entries.length; index += 50) {
    const chunk = entries.slice(index, index + 50);
    await db.batch(chunk.map((entry) => db.prepare(
      `INSERT INTO authoring_catalog
        (owner_id, project_id, localization_key, locale, value, value_hash, metadata_json, generation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, project_id, localization_key, locale) DO UPDATE SET
         value = excluded.value,
         value_hash = excluded.value_hash,
         metadata_json = excluded.metadata_json,
         generation = excluded.generation,
         updated_at = excluded.updated_at`,
    ).bind(owner, projectId, entry.localizationKey, entry.locale, entry.value, entry.valueHash, JSON.stringify(entry.metadata), generation, now)));
  }
  await db.prepare(
    "DELETE FROM authoring_catalog WHERE owner_id = ? AND project_id = ? AND generation != ?",
  ).bind(owner, projectId, generation).run();
  await db.prepare(
    `INSERT INTO authoring_workspace
      (owner_id, project_id, project_title, default_locale, schema_version, generation, workspace_json, updated_at)
     VALUES (?, ?, ?, ?, 2, ?, ?, ?)
     ON CONFLICT(owner_id, project_id) DO UPDATE SET
       project_title = excluded.project_title,
       default_locale = excluded.default_locale,
       schema_version = excluded.schema_version,
       generation = excluded.generation,
       workspace_json = excluded.workspace_json,
       updated_at = excluded.updated_at`,
  ).bind(owner, projectId, projectTitle, defaultLocale, generation, workspaceJson, now).run();
  return { projectId, generation, count: entries.length, updatedAt: now };
}

async function getCatalog(db, owner, projectId) {
  const [result, workspaceRow] = await Promise.all([db.prepare(
    `SELECT localization_key, locale, value, value_hash, metadata_json, generation, updated_at
     FROM authoring_catalog
     WHERE owner_id = ? AND project_id = ?
     ORDER BY localization_key`,
  ).bind(owner, projectId).all(), db.prepare(
    `SELECT project_title, default_locale, schema_version, generation, workspace_json, updated_at
     FROM authoring_workspace WHERE owner_id = ? AND project_id = ?`,
  ).bind(owner, projectId).first()]);
  const entries = (result.results || []).map((row) => {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata_json); } catch { /* ignore corrupt optional metadata */ }
    return {
      localizationKey: row.localization_key,
      locale: row.locale,
      value: row.value,
      valueHash: row.value_hash,
      ...metadata,
    };
  });
  let workspace;
  try { workspace = workspaceRow?.workspace_json ? JSON.parse(workspaceRow.workspace_json) : undefined; } catch { /* ignore corrupt workspace */ }
  return {
    schemaVersion: workspaceRow?.schema_version || 1,
    projectId,
    projectTitle: workspaceRow?.project_title || projectId,
    defaultLocale: workspaceRow?.default_locale || result.results?.[0]?.locale || "ko",
    generation: workspaceRow?.generation || result.results?.[0]?.generation || null,
    updatedAt: workspaceRow?.updated_at || result.results?.[0]?.updated_at || null,
    entries,
    workspace,
  };
}

async function enqueueChanges(db, owner, payload) {
  if (!Array.isArray(payload?.changes) || payload.changes.length < 1 || payload.changes.length > MAX_CHANGE_BATCH) {
    throw Object.assign(new Error(`변경은 한 번에 1-${MAX_CHANGE_BATCH}개까지 보낼 수 있습니다.`), { code: "INVALID_BATCH" });
  }
  const changes = payload.changes.map(validateChange);
  const now = new Date().toISOString();
  for (const change of changes) {
    await db.batch([
      db.prepare(
        `UPDATE authoring_changes
         SET status = 'superseded', updated_at = ?
         WHERE owner_id = ? AND project_id = ? AND localization_key = ? AND locale = ?
           AND status = 'pending' AND event_id != ?`,
      ).bind(now, owner, change.projectId, change.localizationKey, change.locale, change.eventId),
      db.prepare(
        `INSERT INTO authoring_changes
          (owner_id, event_id, project_id, localization_key, locale, base_value, base_value_hash,
           next_value, device_id, client_created_at, server_created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(owner_id, event_id) DO NOTHING`,
      ).bind(
        owner, change.eventId, change.projectId, change.localizationKey, change.locale,
        change.baseValue, change.baseValueHash, change.nextValue, change.deviceId,
        change.clientCreatedAt, now, now,
      ),
    ]);
    const stored = await db.prepare(
      `SELECT project_id, localization_key, locale, base_value_hash, next_value, device_id
       FROM authoring_changes WHERE owner_id = ? AND event_id = ?`,
    ).bind(owner, change.eventId).first();
    if (!stored || stored.project_id !== change.projectId || stored.localization_key !== change.localizationKey
      || stored.locale !== change.locale || stored.base_value_hash !== change.baseValueHash
      || stored.next_value !== change.nextValue || stored.device_id !== change.deviceId) {
      throw Object.assign(new Error("같은 eventId에 다른 내용이 이미 저장되어 있습니다."), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
    }
  }
  return { accepted: changes.map((change) => change.eventId), serverTime: now };
}

async function enqueueSceneChanges(db, owner, payload) {
  if (!Array.isArray(payload?.changes) || payload.changes.length < 1 || payload.changes.length > MAX_SCENE_CHANGE_BATCH) {
    throw Object.assign(new Error(`장면 변경은 한 번에 1-${MAX_SCENE_CHANGE_BATCH}개까지 보낼 수 있습니다.`), { code: "INVALID_BATCH" });
  }
  const changes = payload.changes.map(validateSceneChange);
  const now = new Date().toISOString();
  for (const change of changes) {
    await db.batch([
      db.prepare(
        `UPDATE authoring_scene_changes
         SET status = 'superseded', updated_at = ?
         WHERE owner_id = ? AND project_id = ? AND scene_id = ?
           AND status = 'pending' AND event_id != ?`,
      ).bind(now, owner, change.projectId, change.sceneId, change.eventId),
      db.prepare(
        `INSERT INTO authoring_scene_changes
          (owner_id, event_id, project_id, scene_id, base_scene_hash, next_scene_hash,
           base_scene_json, next_scene_json, device_id, client_created_at,
           server_created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(owner_id, event_id) DO NOTHING`,
      ).bind(
        owner, change.eventId, change.projectId, change.sceneId,
        change.baseSceneHash, change.nextSceneHash, change.baseSceneJson, change.nextSceneJson,
        change.deviceId, change.clientCreatedAt, now, now,
      ),
    ]);
    const stored = await db.prepare(
      `SELECT project_id, scene_id, base_scene_hash, next_scene_hash, device_id
       FROM authoring_scene_changes WHERE owner_id = ? AND event_id = ?`,
    ).bind(owner, change.eventId).first();
    if (!stored || stored.project_id !== change.projectId || stored.scene_id !== change.sceneId
      || stored.base_scene_hash !== change.baseSceneHash || stored.next_scene_hash !== change.nextSceneHash
      || stored.device_id !== change.deviceId) {
      throw Object.assign(new Error("같은 eventId에 다른 장면 변경이 이미 저장되어 있습니다."), { code: "IDEMPOTENCY_CONFLICT", status: 409 });
    }
  }
  return { accepted: changes.map((change) => change.eventId), serverTime: now };
}

function changeRow(row) {
  return {
    eventId: row.event_id,
    projectId: row.project_id,
    localizationKey: row.localization_key,
    locale: row.locale,
    baseValue: row.base_value,
    baseValueHash: row.base_value_hash,
    nextValue: row.next_value,
    deviceId: row.device_id,
    clientCreatedAt: row.client_created_at,
    serverCreatedAt: row.server_created_at,
    updatedAt: row.updated_at,
    status: row.status,
    reason: row.reason || undefined,
    currentValue: row.current_value ?? undefined,
    currentValueHash: row.current_value_hash ?? undefined,
  };
}

function sceneChangeRow(row) {
  let baseScene;
  let nextScene;
  let currentScene;
  try { baseScene = JSON.parse(row.base_scene_json); } catch { baseScene = undefined; }
  try { nextScene = JSON.parse(row.next_scene_json); } catch { nextScene = undefined; }
  try { currentScene = row.current_scene_json ? JSON.parse(row.current_scene_json) : undefined; } catch { currentScene = undefined; }
  return {
    eventId: row.event_id,
    projectId: row.project_id,
    sceneId: row.scene_id,
    baseSceneHash: row.base_scene_hash,
    nextSceneHash: row.next_scene_hash,
    baseScene,
    nextScene,
    deviceId: row.device_id,
    clientCreatedAt: row.client_created_at,
    serverCreatedAt: row.server_created_at,
    updatedAt: row.updated_at,
    status: row.status,
    reason: row.reason || undefined,
    currentScene,
    currentSceneHash: row.current_scene_hash || undefined,
  };
}

async function getChanges(db, owner, projectId, status) {
  const onlyPending = status === "pending";
  const result = await db.prepare(
    `SELECT * FROM authoring_changes
     WHERE owner_id = ? AND project_id = ? ${onlyPending ? "AND status = 'pending'" : ""}
     ORDER BY server_created_at DESC LIMIT 250`,
  ).bind(owner, projectId).all();
  return { projectId, changes: (result.results || []).map(changeRow), serverTime: new Date().toISOString() };
}

async function getSceneChanges(db, owner, projectId, status) {
  const onlyPending = status === "pending";
  const result = await db.prepare(
    `SELECT * FROM authoring_scene_changes
     WHERE owner_id = ? AND project_id = ? ${onlyPending ? "AND status = 'pending'" : ""}
     ORDER BY server_created_at DESC LIMIT 100`,
  ).bind(owner, projectId).all();
  return { projectId, changes: (result.results || []).map(sceneChangeRow), serverTime: new Date().toISOString() };
}

async function saveReceipts(db, owner, payload) {
  const projectId = validateProjectId(payload?.projectId);
  if (!Array.isArray(payload?.receipts) || payload.receipts.length < 1 || payload.receipts.length > MAX_CHANGE_BATCH) {
    throw Object.assign(new Error("처리 결과 묶음이 올바르지 않습니다."), { code: "INVALID_RECEIPTS" });
  }
  const now = new Date().toISOString();
  const receipts = payload.receipts.map((raw) => {
    const eventId = requireString(raw?.eventId, "eventId", 96);
    const status = requireString(raw?.status, "status", 16);
    if (!EVENT_ID.test(eventId) || !TERMINAL_STATUSES.has(status)) {
      throw Object.assign(new Error("처리 결과 형식이 올바르지 않습니다."), { code: "INVALID_RECEIPT" });
    }
    return {
      eventId,
      status,
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 500) : null,
      currentValue: typeof raw.currentValue === "string" ? raw.currentValue.slice(0, MAX_TEXT_LENGTH) : null,
      currentValueHash: typeof raw.currentValueHash === "string" && SHA256.test(raw.currentValueHash) ? raw.currentValueHash : null,
    };
  });
  const results = await db.batch(receipts.map((receipt) => db.prepare(
    `UPDATE authoring_changes
     SET status = ?, reason = ?, current_value = ?, current_value_hash = ?, updated_at = ?
     WHERE owner_id = ? AND project_id = ? AND event_id = ? AND status = 'pending'`,
  ).bind(
    receipt.status, receipt.reason, receipt.currentValue, receipt.currentValueHash,
    now, owner, projectId, receipt.eventId,
  )));
  return {
    projectId,
    updated: results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0),
    serverTime: now,
  };
}

async function saveSceneReceipts(db, owner, payload) {
  const projectId = validateProjectId(payload?.projectId);
  if (!Array.isArray(payload?.receipts) || payload.receipts.length < 1 || payload.receipts.length > MAX_SCENE_CHANGE_BATCH) {
    throw Object.assign(new Error("장면 처리 결과 묶음이 올바르지 않습니다."), { code: "INVALID_RECEIPTS" });
  }
  const now = new Date().toISOString();
  const receipts = payload.receipts.map((raw) => {
    const eventId = requireString(raw?.eventId, "eventId", 96);
    const status = requireString(raw?.status, "status", 16);
    if (!EVENT_ID.test(eventId) || !TERMINAL_STATUSES.has(status)) {
      throw Object.assign(new Error("장면 처리 결과 형식이 올바르지 않습니다."), { code: "INVALID_RECEIPT" });
    }
    let currentSceneJson = null;
    if (raw.currentScene && typeof raw.currentScene === "object") {
      currentSceneJson = JSON.stringify(raw.currentScene);
      if (new TextEncoder().encode(currentSceneJson).byteLength > MAX_SCENE_JSON_BYTES) {
        throw Object.assign(new Error("현재 장면 처리 결과가 너무 큽니다."), { code: "SCENE_RECEIPT_TOO_LARGE" });
      }
    }
    return {
      eventId,
      status,
      reason: typeof raw.reason === "string" ? raw.reason.slice(0, 500) : null,
      currentSceneJson,
      currentSceneHash: typeof raw.currentSceneHash === "string" && SHA256.test(raw.currentSceneHash) ? raw.currentSceneHash : null,
    };
  });
  const results = await db.batch(receipts.map((receipt) => db.prepare(
    `UPDATE authoring_scene_changes
     SET status = ?, reason = ?, current_scene_json = ?, current_scene_hash = ?, updated_at = ?
     WHERE owner_id = ? AND project_id = ? AND event_id = ? AND status = 'pending'`,
  ).bind(
    receipt.status, receipt.reason, receipt.currentSceneJson, receipt.currentSceneHash,
    now, owner, projectId, receipt.eventId,
  )));
  return {
    projectId,
    updated: results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0),
    serverTime: now,
  };
}

export async function handleAuthoringSync(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(API_PREFIX)) return null;
  const owner = ownerId(request, url);
  if (!owner) return error("AUTHENTICATION_REQUIRED", "로그인이 필요합니다.", 401);
  if (!env.DB) return error("DATABASE_UNAVAILABLE", "동기화 저장소를 사용할 수 없습니다.", 503);
  if (!["GET", "POST"].includes(request.method)) return error("METHOD_NOT_ALLOWED", "허용되지 않은 요청입니다.", 405);
  if (request.method === "POST" && !sameOriginWrite(request, url)) return error("ORIGIN_REJECTED", "다른 출처의 쓰기 요청은 허용되지 않습니다.", 403);

  try {
    await ensureSchema(env.DB);
    const route = url.pathname.slice(API_PREFIX.length);
    if (route === "catalog" && request.method === "GET") {
      const projectId = validateProjectId(url.searchParams.get("projectId"));
      return response({ ok: true, catalog: await getCatalog(env.DB, owner, projectId) });
    }
    if (route === "catalog" && request.method === "POST") {
      return response({ ok: true, catalog: await putCatalog(env.DB, owner, await readJson(request)) });
    }
    if (route === "changes" && request.method === "GET") {
      const projectId = validateProjectId(url.searchParams.get("projectId"));
      return response({ ok: true, ...(await getChanges(env.DB, owner, projectId, url.searchParams.get("status"))) });
    }
    if (route === "changes" && request.method === "POST") {
      return response({ ok: true, ...(await enqueueChanges(env.DB, owner, await readJson(request))) }, 202);
    }
    if (route === "scene-changes" && request.method === "GET") {
      const projectId = validateProjectId(url.searchParams.get("projectId"));
      return response({ ok: true, ...(await getSceneChanges(env.DB, owner, projectId, url.searchParams.get("status"))) });
    }
    if (route === "scene-changes" && request.method === "POST") {
      return response({ ok: true, ...(await enqueueSceneChanges(env.DB, owner, await readJson(request))) }, 202);
    }
    if (route === "receipts" && request.method === "POST") {
      return response({ ok: true, ...(await saveReceipts(env.DB, owner, await readJson(request))) });
    }
    if (route === "scene-receipts" && request.method === "POST") {
      return response({ ok: true, ...(await saveSceneReceipts(env.DB, owner, await readJson(request))) });
    }
    return error("NOT_FOUND", "동기화 API를 찾을 수 없습니다.", 404);
  } catch (failure) {
    const isExpected = typeof failure?.code === "string";
    if (!isExpected) console.error("authoring sync failure", failure);
    const status = isExpected ? Number(failure?.status) || 400 : 500;
    return error(
      isExpected ? failure.code : "SYNC_INTERNAL_ERROR",
      isExpected && failure instanceof Error ? failure.message : "동기화 저장소에서 요청을 처리하지 못했습니다.",
      status,
    );
  }
}

export const authoringSyncSchema = SCHEMA;
export { sameOriginWrite, validateCatalogEntry, validateChange, validateSceneChange, validateWorkspace };
