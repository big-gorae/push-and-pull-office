import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import { GameLocalizer } from "./gameI18n";
import { createSession, type PlayerSession } from "./playerRuntime";
import { normalizePlayerProfile, normalizePlayerSettings, normalizeSaveSlot } from "./playerStorage";
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

function sessionAtNightPlan(): PlayerSession {
  const session = createSession(runtime, "seo_a");
  session.phase = "self_development";
  session.state.progress.time = { day: 1, act: 1, slot: "after_work" };
  session.nightPhase = {
    status: "selecting",
    day: 1,
    profile: structuredClone(session.state.visible.protagonist.self_development),
    options: [],
  };
  return session;
}

describe("locale-independent save schema", () => {
  it("fills and bounds persistent debug layout settings", () => {
    expect(normalizePlayerSettings(undefined)).toMatchObject({
      debugMode: false,
      characterX: -8,
      characterY: 8,
      characterScale: 108,
    });
    expect(normalizePlayerSettings({
      debugMode: true,
      characterX: -200,
      characterY: 200,
      characterScale: 500,
      locale: "invalid",
    }, ["ko", "en"], "ko")).toMatchObject({
      debugMode: true,
      characterX: -24,
      characterY: 24,
      characterScale: 135,
      locale: "ko",
    });
  });

  it("normalizes every first route clear into both post-ending mode unlocks", () => {
    expect(normalizePlayerProfile({
      clearedRoutes: ["future_route"],
      unlockedModes: ["base"],
      memories: [],
    }).unlockedModes).toEqual(["base", "truth_view", "survivor_view"]);
  });

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

  it("stores and localizes the nightly self-development preview", () => {
    const slot = sessionSlot(sessionAtNightPlan());
    expect(slot.schema_version).toBe(4);
    expect(slot.preview).toMatchObject({
      kind: "self_development",
      day: 1,
      slot: "after_work",
      mode: "perceived",
    });

    const korean = savePreview(slot, new GameLocalizer(runtime, "ko"));
    const english = savePreview(slot, new GameLocalizer(runtime, "en"));
    expect(korean.title).toBe("오늘 밤, 무엇을 준비할까?");
    expect(english.title).toBe("What should I work on tonight?");
    expect(korean.line).not.toBe(english.line);
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
    expect(migrated?.schema_version).toBe(4);
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
