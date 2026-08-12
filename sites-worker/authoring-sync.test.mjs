import assert from "node:assert/strict";
import test from "node:test";
import { sameOriginWrite, validateCatalogEntry, validateChange } from "./authoring-sync.js";

const hash = "a".repeat(64);

test("change validation accepts a well-formed event and rejects a corrupt hash", () => {
  const event = {
    eventId: "018f4a56-c0de-7abc-8def-0123456789ab",
    projectId: "love_office_story_1",
    localizationKey: "scene.intro.node.greeting.perceived.line",
    locale: "ko",
    baseValue: "기존 대사",
    baseValueHash: hash,
    nextValue: "수정 대사",
    deviceId: "phone-0123456789abcdef",
    clientCreatedAt: "2026-08-13T12:00:00.000Z",
  };

  assert.deepEqual(validateChange(event), event);
  assert.throws(() => validateChange({ ...event, baseValueHash: "not-a-hash" }), /형식/);
});

test("catalog validation strips untrusted metadata to the public contract", () => {
  const entry = validateCatalogEntry({
    localizationKey: "scene.intro.node.greeting.perceived.line",
    locale: "ko",
    value: "대사",
    valueHash: hash,
    domain: "scene",
    documentId: "intro",
    documentTitle: "인트로",
    context: { nodeId: "greeting" },
    path: "/Users/example/secret.yaml",
  });

  assert.equal("path" in entry, false);
  assert.deepEqual(entry.metadata.context, { nodeId: "greeting" });
});

test("production writes require an exact same-origin Origin header", () => {
  const url = new URL("https://example.com/api/authoring/v1/changes");
  assert.equal(sameOriginWrite(new Request(url, { method: "POST" }), url), false);
  assert.equal(sameOriginWrite(new Request(url, { method: "POST", headers: { origin: url.origin } }), url), true);
  assert.equal(sameOriginWrite(new Request(url, { method: "POST", headers: { origin: "https://attacker.test" } }), url), false);

  const local = new URL("http://127.0.0.1:1420/api/authoring/v1/changes");
  assert.equal(sameOriginWrite(new Request(local, { method: "POST" }), local), true);
});
