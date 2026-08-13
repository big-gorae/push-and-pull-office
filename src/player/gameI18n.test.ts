import { describe, expect, it } from "vitest";
import runtimeJson from "../../build/story-runtime.json";
import type { Runtime } from "../types";
import { dialogueKey } from "./WebGame";
import { GameLocalizer, gameLocales } from "./gameI18n";

const runtime = runtimeJson as unknown as Runtime;

describe("GameLocalizer", () => {
  it("uses Korean as the default game language and preserves the requested title", () => {
    const i18n = new GameLocalizer(runtime);

    expect(i18n.locale).toBe("ko");
    expect(i18n.ui("app.title")).toBe(
      "밀당 오피스 - 초필살 다크 스킬로 그녀의 마음을 케에에에엣치 존잘 미중년남 이야기",
    );
    expect(`${i18n.ui("app.catchphrase")} ${i18n.ui("app.edition")}`).toBe(
      "초필살 다크 스킬로 그녀의 마음을 케에에에엣치 존잘 미중년남 이야기",
    );
    expect(i18n.ui("mode.survivor.copy")).toBe("새로운 그녀로 새로운 이야기를 만들어 보아요");
    expect(i18n.ui("app.kicker")).not.toContain("17");
    expect(i18n.characterName("yoon_seo_a")).toBe("윤서아");
    expect(i18n.characterName("member.jeong_da_eun")).toBe("정주임");
  });

  it("switches UI and character names through one locale object", () => {
    const i18n = new GameLocalizer(runtime, "en");

    expect(i18n.ui("menu.newGame")).toBe("New Game");
    expect(i18n.characterName("cha_min_kyung")).toBe("Cha Min-kyung");
    expect(i18n.ui("deadline.days", { count: 3 })).toBe("3 days left");
  });

  it("falls back to the Korean source when a story translation is missing", () => {
    const i18n = new GameLocalizer(runtime, "en");
    const source = "번역되지 않은 한국어 원문";

    expect(i18n.story("missing.stable.key", source)).toBe(source);
  });

  it("shows newly saved source text immediately in the default locale only", () => {
    const key = "scenes.common.scene.nodes.greeting.line";
    const overrides = { [key]: "게임 안에서 고친 문장" };

    expect(new GameLocalizer(runtime, "ko", overrides).story(key, "원래 문장")).toBe("게임 안에서 고친 문장");
    expect(new GameLocalizer(runtime, "en", overrides).story(key, "원래 문장")).not.toBe("게임 안에서 고친 문장");
  });

  it("applies a hot edit only to the matching locale", () => {
    const key = "scenes.seo_a.email_request.nodes.request.line";
    const overrides = { [`en:${key}`]: "Edited English line" };

    expect(new GameLocalizer(runtime, "en", overrides).story(key, "원래 문장")).toBe("Edited English line");
    expect(new GameLocalizer(runtime, "ko", overrides).story(key, "원래 문장")).not.toBe("Edited English line");
  });

  it("keeps the default variant segment when the source node owns variants", () => {
    expect(dialogueKey("common.scene", "callback", "default", "line", true)).toBe(
      "scenes.common.scene.nodes.callback.variants.default.line",
    );
    expect(dialogueKey("common.scene", "callback", "default", "line")).toBe(
      "scenes.common.scene.nodes.callback.line",
    );
  });

  it("discovers locales from runtime data without a code allowlist", () => {
    const copy = structuredClone(runtime);
    copy.localization.supported_locales.push("fr");
    copy.localization.locales.fr = {
      schema_version: 1,
      id: "fr",
      name: "French",
      native_name: "Français",
      fallback: "en",
      strings: {},
    };
    copy.localization.catalogs.fr = copy.localization.catalogs.en;
    expect(gameLocales(copy)).toContain("fr");
    expect(new GameLocalizer(copy, "fr").localeName("fr")).toBe("Français");
  });
});
