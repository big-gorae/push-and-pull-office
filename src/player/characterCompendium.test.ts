import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import type { PlayerProfile } from "./playerStorage";
import { characterProfileFieldUnlocked, primaryCharacterProfileIds } from "./WebGame";

const runtime = runtimeJson as unknown as Runtime;

describe("character compendium", () => {
  const freshProfile: PlayerProfile = {
    clearedRoutes: [],
    unlockedModes: ["base"],
    memories: [],
  };

  it("keeps the three main profiles in Eun-sol, Min-kyung, Na-kyung order", () => {
    expect(primaryCharacterProfileIds()).toEqual([
      "yoon_seo_a",
      "cha_min_kyung",
      "kang_yoo_jin",
    ]);
  });

  it("shows every field slot while unlocking only discovered values", () => {
    const fields = runtime.characters.yoon_seo_a.player_profile?.fields;
    expect(Object.keys(fields || {})).toEqual([
      "name",
      "affiliation",
      "mbti",
      "hobby",
      "likes",
      "ideal_type",
      "residence",
      "tmi",
    ]);
    expect(characterProfileFieldUnlocked(fields!.name.unlock_memory, freshProfile)).toBe(false);
    expect(characterProfileFieldUnlocked(fields!.name.unlock_memory, {
      ...freshProfile,
      memories: [fields!.name.unlock_memory],
    })).toBe(true);
  });

  it("registers compact cards for Seo Jung-woo and every non-featured coworker", () => {
    const featured = new Set(primaryCharacterProfileIds());
    const others = (runtime.world?.by_kind.member || [])
      .map((id) => runtime.world?.entities[id])
      .filter((member) => member && !featured.has(String(member.story_character || "")));
    expect(others.some((member) => member?.id === "member.han_do_yoon")).toBe(true);
    expect(others.every((member) => typeof member?.compendium_summary === "string")).toBe(true);
  });

  it("connects every profile value to a collectible event memory", () => {
    const eventMemories = new Set(Object.values(runtime.events).flatMap((event) =>
      (event.on_seen?.effects || [])
        .filter((effect) => effect.path === "progress.memories" && effect.op === "append_unique")
        .map((effect) => String(effect.value)),
    ));
    const profileMemories = Object.values(runtime.characters).flatMap((character) =>
      Object.values(character.player_profile?.fields || {}).map((field) => field.unlock_memory),
    );
    expect(profileMemories.length).toBe(24);
    expect(profileMemories.every((memory) => eventMemories.has(memory))).toBe(true);
  });
});
