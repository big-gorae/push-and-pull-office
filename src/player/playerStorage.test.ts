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

  it("preserves explicit profile unlocks without inventing them from route clears", () => {
    expect(normalizePlayerProfile({
      clearedRoutes: ["future_route"],
      unlockedModes: ["base"],
      memories: [],
    }).unlockedModes).toEqual(["base"]);
  });

  it("stores only stable preview identifiers and rerenders the same slot in another locale", () => {
    const slot = sessionSlot(sessionAtTranslatedScene());
    expect(slot.preview).toMatchObject({
      kind: "scene",
      sceneId: "seo_a.email_request",
      nodeId: "request",
      gameModeId: "base",
      campaignId: "main",
      continuityId: "main",
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
    expect(slot.schema_version).toBe(6);
    expect(slot.preview).toMatchObject({
      kind: "self_development",
      day: 1,
      slot: "after_work",
      gameModeId: "base",
    });

    const korean = savePreview(slot, new GameLocalizer(runtime, "ko"));
    const english = savePreview(slot, new GameLocalizer(runtime, "en"));
    expect(korean.title).toBe("밤");
    expect(english.title).toBe("Night");
    expect(korean.line).toBe("집에 돌아와 씻고 나왔다. 이제 뭘 할까?");
    expect(korean.line).not.toBe(english.line);
  });

  it("normalizes a v2 slot without rewriting it and drops translated backlog caches", () => {
    const session = sessionAtTranslatedScene() as unknown as Omit<PlayerSession, "backlog"> & {
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
      session: session as unknown as PlayerSession,
    };
    const migrated = normalizeSaveSlot(legacy, runtime);
    expect(migrated?.schema_version).toBe(6);
    expect(migrated?.preview.variantId).toBe("default");
    expect(migrated?.legacy).toEqual({ sceneTitle: "옛 장면 제목", line: "옛 대사" });
    expect(migrated?.session.backlog[0]).not.toHaveProperty("text");
    expect(migrated?.session.backlog[0]).not.toHaveProperty("perceivedText");

    const rewritten = sessionSlot(migrated!.session);
    expect(rewritten).not.toHaveProperty("legacy");
    expect(JSON.stringify(rewritten)).not.toContain("옛 대사");
    expect(JSON.stringify(rewritten)).not.toContain("옛 번역 문자열");
  });

  it("migrates a v4 reality session into the single base mode", () => {
    const current = createSession(runtime, "seo_a");
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.version = 4;
    legacy.mode = "reality";
    delete legacy.gameModeId;
    delete legacy.continuityId;
    delete legacy.viewLayer;
    const original = structuredClone(legacy);
    const migrated = normalizeSaveSlot({ schema_version: 4, savedAt: 456, session: legacy }, runtime);
    expect(legacy).toEqual(original);
    expect(migrated?.session).toMatchObject({
      version: 6,
      gameModeId: "base",
      campaignId: "main",
      continuityId: "main",
    });
    expect(migrated?.preview).toMatchObject({
      gameModeId: "base",
      campaignId: "main",
      continuityId: "main",
    });
  });

  it("migrates retired initiative and drops perceived-state fields from legacy saves", () => {
    const legacy = structuredClone(sessionAtTranslatedScene()) as unknown as PlayerSession & {
      state: PlayerSession["state"] & {
        visible: PlayerSession["state"]["visible"] & {
          heroines: Record<string, { affection?: number; initiative?: number; perceived_state?: string }>;
        };
      };
    };
    delete (legacy.state.visible.heroines.yoon_seo_a as { affection?: number }).affection;
    legacy.state.visible.heroines.yoon_seo_a.initiative = 77;
    legacy.state.visible.heroines.yoon_seo_a.perceived_state = "pull";

    const migrated = normalizeSaveSlot({ schema_version: 6, savedAt: 789, session: legacy }, runtime);
    expect(migrated?.session.state.visible.heroines.yoon_seo_a).toEqual({ affection: 77 });
    expect(JSON.stringify(migrated)).not.toContain("perceived_state");
    expect(JSON.stringify(migrated)).not.toContain("initiative");
  });

  it("keeps pre-v4 saves compatible by assigning the only historical main campaign", () => {
    const current = sessionAtTranslatedScene();
    const legacy = structuredClone(current) as unknown as Record<string, unknown>;
    legacy.version = 3;
    legacy.mode = "perceived";
    delete legacy.gameModeId;
    delete legacy.campaignId;
    delete legacy.continuityId;
    delete legacy.viewLayer;
    const migrated = normalizeSaveSlot({ schema_version: 3, savedAt: 455, session: legacy }, runtime);
    expect(migrated?.session).toMatchObject({
      version: 6,
      gameModeId: "base",
      campaignId: "main",
      continuityId: "main",
    });
  });

  it("rejects incompatible current and future saves instead of choosing a campaign fallback", () => {
    const current = sessionAtTranslatedScene();
    const missingCampaign = structuredClone(current) as unknown as Record<string, unknown>;
    delete missingCampaign.campaignId;
    expect(normalizeSaveSlot({ schema_version: 5, savedAt: 1, session: missingCampaign }, runtime)).toBeUndefined();

    const unknownCampaign = structuredClone(current);
    unknownCampaign.campaignId = "missing";
    expect(normalizeSaveSlot({ schema_version: 5, savedAt: 2, session: unknownCampaign }, runtime)).toBeUndefined();
    expect(normalizeSaveSlot({ schema_version: 7, savedAt: 3, session: current }, runtime)).toBeUndefined();

    const incompleteV4 = structuredClone(current) as unknown as Record<string, unknown>;
    incompleteV4.version = 4;
    incompleteV4.mode = "perceived";
    delete incompleteV4.gameModeId;
    delete incompleteV4.campaignId;
    delete incompleteV4.continuityId;
    delete incompleteV4.viewLayer;
    expect(normalizeSaveSlot({ schema_version: 4, savedAt: 4, session: incompleteV4 }, runtime)).toBeUndefined();
  });

  it("derives preview identity from the normalized session", () => {
    const current = sessionAtTranslatedScene();
    const migrated = normalizeSaveSlot({
      ...sessionSlot(current),
      preview: {
        ...sessionSlot(current).preview,
        gameModeId: "survivor_view",
      },
    }, runtime);
    expect(migrated?.preview).toMatchObject({ gameModeId: "base" });
  });
});
