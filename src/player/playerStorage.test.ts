import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import { GameLocalizer } from "./gameI18n";
import { createSession, type PlayerSession } from "./playerRuntime";
import { normalizeSaveSlot } from "./playerStorage";
import { savePreview, sessionSlot } from "./WebGame";

const runtime = runtimeJson as unknown as Runtime;

function sessionAtTranslatedScene(): PlayerSession {
  const session = createSession(runtime, "seo_a");
  session.phase = "scene";
  session.sceneId = "seo_a.email_request";
  session.nodeId = "request";
  session.routeId = "seo_a";
  session.currentEventId = "seo_a.email_request";
  return session;
}

describe("locale-independent save schema", () => {
  it("stores only stable preview identifiers and rerenders the same slot in another locale", () => {
    const slot = sessionSlot(sessionAtTranslatedScene());
    expect(slot.preview).toMatchObject({
      kind: "scene",
      sceneId: "seo_a.email_request",
      nodeId: "request",
      mode: "perceived",
    });
    expect(slot).not.toHaveProperty("sceneTitle");
    expect(slot).not.toHaveProperty("line");
    expect(JSON.stringify(slot)).not.toContain("이메일로 보내 주세요");

    const korean = savePreview(slot, new GameLocalizer(runtime, "ko"));
    const english = savePreview(slot, new GameLocalizer(runtime, "en"));
    expect(korean.title).not.toBe(english.title);
    expect(korean.line).not.toBe(english.line);
    expect(english.title).toBe("Send It by Email");
    expect(english.line).toContain("Please send");
  });

  it("normalizes a v2 slot without rewriting it and drops translated backlog caches", () => {
    const session = sessionAtTranslatedScene() as PlayerSession & {
      backlog: Array<Record<string, unknown>>;
    };
    session.backlog = [{
      id: "legacy",
      kind: "dialogue",
      sceneId: session.sceneId,
      nodeId: session.nodeId,
      modeAtPresentation: "perceived",
      speakerId: "yoon_seo_a",
      text: "옛 번역 문자열",
      perceivedText: "옛 인식 문자열",
    }];
    const legacy = {
      schema_version: 2,
      savedAt: 123,
      sceneId: session.sceneId,
      nodeId: session.nodeId,
      sceneTitle: "옛 장면 제목",
      line: "옛 대사",
      session,
    };
    const migrated = normalizeSaveSlot(legacy, runtime);
    expect(migrated?.schema_version).toBe(3);
    expect(migrated?.preview.variantId).toBe("default");
    expect(migrated?.legacy).toEqual({ sceneTitle: "옛 장면 제목", line: "옛 대사" });
    expect(migrated?.session.backlog[0]).not.toHaveProperty("text");
    expect(migrated?.session.backlog[0]).not.toHaveProperty("perceivedText");

    const rewritten = sessionSlot(migrated!.session);
    expect(rewritten).not.toHaveProperty("legacy");
    expect(JSON.stringify(rewritten)).not.toContain("옛 대사");
    expect(JSON.stringify(rewritten)).not.toContain("옛 번역 문자열");
  });
});
