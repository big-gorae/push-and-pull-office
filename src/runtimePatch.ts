import { clone } from "./storyLogic";
import type { JsonValue, Runtime } from "./types";

export type RuntimePatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: JsonValue;
};

export type RuntimePatch = {
  baseSourceSha256?: string;
  sourceSha256?: string;
  operations: RuntimePatchOperation[];
};

export type RuntimeUpdate = {
  runtime?: Runtime;
  runtimePatch?: RuntimePatch;
};

function pointerParts(path: string): string[] {
  if (path === "/") return [];
  if (!path.startsWith("/")) throw new Error(`INVALID_RUNTIME_PATCH_PATH: ${path}`);
  return path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function copyValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  return clone(value);
}

function arrayIndex(part: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9]\d*)$/.test(part)) throw new Error(`INVALID_RUNTIME_PATCH_INDEX: ${part}`);
  const index = Number(part);
  if (index < 0 || index > length || (!allowEnd && index === length)) {
    throw new Error(`INVALID_RUNTIME_PATCH_INDEX: ${part}`);
  }
  return index;
}

function patchAtPath(
  current: unknown,
  parts: string[],
  operation: RuntimePatchOperation,
  depth = 0,
): unknown {
  if (!current || typeof current !== "object") {
    throw new Error(`INVALID_RUNTIME_PATCH_PATH: ${operation.path}`);
  }
  const key = parts[depth];
  const atLeaf = depth === parts.length - 1;
  if (Array.isArray(current)) {
    const next = current.slice();
    if (atLeaf) {
      if (operation.op === "add") {
        if (key === "-") next.push(copyValue(operation.value));
        else next.splice(arrayIndex(key, current.length, true), 0, copyValue(operation.value));
      } else {
        const index = arrayIndex(key, current.length, false);
        if (operation.op === "remove") next.splice(index, 1);
        else next[index] = copyValue(operation.value);
      }
      return next;
    }
    const index = arrayIndex(key, current.length, false);
    next[index] = patchAtPath(current[index], parts, operation, depth + 1);
    return next;
  }

  const record = current as Record<string, unknown>;
  const next = { ...record };
  if (atLeaf) {
    if (operation.op === "remove") {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        throw new Error(`INVALID_RUNTIME_PATCH_PATH: ${operation.path}`);
      }
      delete next[key];
    } else {
      next[key] = copyValue(operation.value);
    }
    return next;
  }
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    throw new Error(`INVALID_RUNTIME_PATCH_PATH: ${operation.path}`);
  }
  next[key] = patchAtPath(record[key], parts, operation, depth + 1);
  return next;
}

export function applyRuntimePatch(current: Runtime, patch: RuntimePatch): Runtime {
  if (patch.baseSourceSha256 && current.source_sha256 !== patch.baseSourceSha256) {
    throw new Error("RUNTIME_PATCH_CONFLICT: runtime generation changed before save response");
  }
  let next: unknown = current;
  for (const operation of patch.operations) {
    const parts = pointerParts(operation.path);
    if (!parts.length) {
      if (operation.op === "remove") throw new Error("INVALID_RUNTIME_PATCH: cannot remove runtime root");
      next = copyValue(operation.value);
      continue;
    }
    next = patchAtPath(next, parts, operation);
  }
  return next as Runtime;
}

export function resolveRuntimeUpdate(current: Runtime, update: RuntimeUpdate): Runtime {
  if (update.runtime) return update.runtime;
  if (update.runtimePatch) return applyRuntimePatch(current, update.runtimePatch);
  throw new Error("SAVE_RESPONSE_MISSING_RUNTIME_UPDATE");
}
