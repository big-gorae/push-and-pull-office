import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import { availableTimelineEvents, createCampaignSession, prepareTimeSlot, startGameMode } from "./playerRuntime";
import { campaignInitialState, resolveModeAccess } from "./gameModes";

const runtime = runtimeJson as unknown as Runtime;
const fresh = { clearedRoutes: [], unlockedModes: ["base"], memories: [] };
const cleared = { clearedRoutes: ["seo_a"], unlockedModes: ["base"], memories: [] };

describe("game mode and campaign separation", () => {
  it("resolves lock state separately from content readiness", () => {
    expect(resolveModeAccess(runtime, "base", fresh)).toBe("ready");
    expect(resolveModeAccess(runtime, "truth_view", fresh)).toBe("locked");
    expect(resolveModeAccess(runtime, "survivor_view", fresh)).toBe("locked");
    expect(resolveModeAccess(runtime, "truth_view", cleared)).toBe("ready");
    expect(resolveModeAccess(runtime, "survivor_view", cleared)).toBe("coming_soon");
  });

  it("starts truth view in the main continuity with a fixed reality layer", () => {
    const result = startGameMode(runtime, cleared, "truth_view");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session).toMatchObject({
      version: 5,
      gameModeId: "truth_view",
      campaignId: "main",
      continuityId: "main",
      viewLayer: "reality",
    });
  });

  it("selects main from the mode registry even when another campaign is ordered first", () => {
    const copy = structuredClone(runtime);
    copy.campaigns = {
      decoy: { ...structuredClone(copy.campaigns.main), id: "decoy", title: "Decoy" },
      main: copy.campaigns.main,
    };
    const result = startGameMode(copy, fresh, "base");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.campaignId).toBe("main");
  });

  it("does not start an unlocked but unimplemented campaign", () => {
    expect(startGameMode(runtime, cleared, "survivor_view")).toEqual({ ok: false, code: "coming_soon" });
  });

  it("returns stable start errors without choosing substitute content", () => {
    expect(startGameMode(runtime, fresh, "truth_view")).toEqual({ ok: false, code: "locked" });
    expect(startGameMode(runtime, fresh, "missing" as never)).toEqual({ ok: false, code: "unknown_mode" });

    const missingCampaign = structuredClone(runtime);
    missingCampaign.game_modes.base.campaign_id = "missing";
    expect(startGameMode(missingCampaign, fresh, "base")).toEqual({ ok: false, code: "missing_campaign" });

    const invalidEntry = structuredClone(runtime);
    invalidEntry.campaigns.main.entry_event_id = "missing.entry";
    expect(startGameMode(invalidEntry, fresh, "base")).toEqual({ ok: false, code: "invalid_entry_event" });
  });

  it("deep-merges the selected campaign initial patch", () => {
    const copy = structuredClone(runtime);
    copy.campaigns.main.initial_state_patch = {
      progress: { flags: { campaign_probe: true } },
    };
    const state = campaignInitialState(copy, "main");
    expect(state.progress.flags.campaign_probe).toBe(true);
    expect(state.visible.heroines.yoon_seo_a).toBeDefined();
  });

  it("filters timeline choices by the active campaign", () => {
    const copy = structuredClone(runtime);
    copy.events["seo_a.email_request"].campaign_id = "foreign";
    const session = createCampaignSession(copy, "base");
    session.phase = "timeline";
    session.state.progress.time = { day: 7, act: 2, slot: "lunch" };
    session.preparedTimeKey = "7:lunch";
    expect(availableTimelineEvents(copy, session).map((event) => event.id)).not.toContain("seo_a.email_request");
  });

  it("neither expires nor automatically runs events owned by another campaign", () => {
    const copy = structuredClone(runtime);
    const foreign = structuredClone(copy.events["seo_a.email_request"]);
    foreign.id = "foreign.event";
    foreign.campaign_id = "foreign";
    foreign.availability = "automatic";
    foreign.scene = undefined;
    foreign.window = { days: [1, 1], deadline_day: 1, slots: ["morning"] };
    foreign.requires = { events: [], conditions: [] };
    copy.events[foreign.id] = foreign;

    const session = createCampaignSession(copy, "base");
    session.phase = "timeline";
    session.currentEventId = undefined;
    session.preparedTimeKey = undefined;
    session.state.progress.time = { day: 2, act: 1, slot: "morning" };
    const prepared = prepareTimeSlot(copy, session);
    expect(prepared.state.progress.events.seen).not.toContain(foreign.id);
    expect(prepared.state.progress.events.missed).not.toContain(foreign.id);
    expect(prepared.state.progress.events.expired).not.toContain(foreign.id);
    expect(prepared.timelineLog.some((entry) => entry.eventId === foreign.id)).toBe(false);
  });

  it("carries only profile progress into a future separate continuity", () => {
    const copy = structuredClone(runtime);
    const survivorCampaign = structuredClone(copy.campaigns.main);
    survivorCampaign.id = "survivor";
    survivorCampaign.title = "Survivor fixture";
    survivorCampaign.entry_event_id = "survivor.entry";
    survivorCampaign.initial_state_patch = { progress: { flags: { survivor_fixture: true } } };
    copy.campaigns.survivor = survivorCampaign;

    const entry = structuredClone(copy.events["anchor.day_01_company_meeting"]);
    entry.id = "survivor.entry";
    entry.campaign_id = "survivor";
    entry.scene = undefined;
    entry.requires = { events: [], conditions: [] };
    entry.on_seen = { effects: [] };
    copy.events[entry.id] = entry;
    copy.game_modes.survivor_view = {
      ...copy.game_modes.survivor_view,
      campaign_id: "survivor",
      content_status: "playable",
    };

    const base = createCampaignSession(copy, "base");
    base.state.hidden.heroines.yoon_seo_a.suspicion = 99;
    base.state.progress.flags.main_session_only = true;
    const result = startGameMode(copy, {
      clearedRoutes: ["seo_a"],
      unlockedModes: ["base", "survivor_view"],
      memories: ["profile_memory"],
    }, "survivor_view");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session).toMatchObject({ campaignId: "survivor", continuityId: "survivor" });
    expect(result.session.state.hidden.heroines.yoon_seo_a.suspicion).toBe(0);
    expect(result.session.state.progress.flags.main_session_only).toBeUndefined();
    expect(result.session.state.progress.flags.survivor_fixture).toBe(true);
    expect(result.session.state.progress.cleared_routes).toEqual(["seo_a"]);
    expect(result.session.state.progress.memories).toEqual(["profile_memory"]);
  });
});
