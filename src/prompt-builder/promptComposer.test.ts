import { describe, expect, it } from "vitest";
import { loadPromptCatalog, parsePromptCatalog } from "./promptCatalog";
import { composePrompt, exactDedupe, splitPromptText } from "./promptComposer";
import type { PromptRuntimeMetadata } from "./types";

describe("NovelAI prompt catalog", () => {
  it("loads character files and joins canonical runtime metadata", () => {
    const catalog = loadPromptCatalog();
    const seoA = catalog.characters.find((character) => character.id === "yoon_seo_a");

    expect(catalog.characters).toHaveLength(5);
    expect(catalog.styleTags).toEqual(["game cg", "year 2024"]);
    expect(catalog.settings.qualityTags).toBe(true);
    expect(catalog.characters.map((character) => character.id)).toEqual([
      "yoon_seo_a",
      "cha_min_kyung",
      "kang_yoo_jin",
      "im_soo_yeon",
      "han_do_yoon",
    ]);
    expect(seoA).toMatchObject({
      displayName: "윤서아",
      age: 24,
      role: "상품기획팀 계약직 사원",
      conceptArt: "assets/concept-art/yoon-seo-a.png",
    });
    expect(seoA?.variants[0].identityTags).toContain("long dark brown hair");
    expect(seoA?.variants[0].identityTags).toContain("large breasts");
  });

  it("reports the source file and JSON path for an invalid reference", () => {
    const defaults = JSON.stringify({
      schemaVersion: 1,
      model: "test",
      settings: {
        qualityTags: false,
        ucPreset: "test",
        guidance: "5–6",
        steps: "28",
        samplers: ["Euler Ancestral"],
      },
      styleTags: ["visual novel"],
      manualQualityTags: ["masterpiece"],
      sharedUndesiredTags: ["3d"],
      basePresets: [{
        id: "sprite_full_body",
        label: "sprite",
        description: "test",
        subjectTags: { female: ["1girl"], male: ["1boy"] },
        tags: ["full body"],
      }],
    });
    const invalidCharacter = JSON.stringify({
      schemaVersion: 1,
      characterId: "test_character",
      order: 10,
      subject: "female",
      accent: "#fff",
      defaultLookId: "missing",
      looks: [{
        id: "default",
        label: "default",
        identityTags: ["girl"],
        outfitTags: ["shirt"],
        characterUndesiredTags: [],
        defaultSituationId: "neutral",
        situations: [{
          id: "neutral",
          label: "neutral",
          basePresetId: "sprite_full_body",
          tags: ["standing"],
        }],
      }],
    });
    const runtime: PromptRuntimeMetadata = { characters: {} };

    expect(() => parsePromptCatalog({
      defaults: { "../../prompt-config/novelai-v45/defaults.json": defaults },
      characters: {
        "../../prompt-config/novelai-v45/characters/test_character.json": invalidCharacter,
      },
    }, runtime)).toThrowError(
      /prompt-config\/novelai-v45\/characters\/test_character\.json \$\.defaultLookId: unknown look id "missing"/,
    );
  });
});

describe("NovelAI prompt composition", () => {
  it("preserves weighted items and exact-dedupes without case folding", () => {
    expect(exactDedupe([
      "girl",
      "1.1::long hair, brown eyes::",
      "girl",
      "Girl",
    ])).toEqual([
      "girl",
      "1.1::long hair, brown eyes::",
      "Girl",
    ]);
    expect(splitPromptText("girl, 1.2::coffee cup, steam::, girl")).toEqual([
      "girl",
      "1.2::coffee cup, steam::",
    ]);
  });

  it("composes separate and combined prompts and applies crop-only tags", () => {
    const catalog = loadPromptCatalog();
    const fullBody = composePrompt(catalog, {
      characterId: "yoon_seo_a",
      variantId: "office",
      formatId: "sprite_full_body",
      situationId: "reference_social_smile",
      extraPrompt: "girl, 1.2::coffee cup, steam::, girl",
    });
    const cropped = composePrompt(catalog, {
      characterId: "yoon_seo_a",
      variantId: "office",
      formatId: "office_desk",
      situationId: "reference_social_smile",
    });

    expect(fullBody.base).toContain("1girl, solo, full body");
    expect(fullBody.character.startsWith("girl, adult, ")).toBe(true);
    expect(fullBody.character).toContain("long dark brown hair");
    expect(fullBody.character).toContain("large breasts, breasts");
    expect(fullBody.character).toContain("1.2::coffee cup, steam::");
    expect(fullBody.character).toContain("black loafers");
    expect(cropped.character).not.toContain("black loafers");
    expect(fullBody.combined).toBe(`${fullBody.base} | ${fullBody.character}`);
    expect(fullBody.uc).not.toContain("Human Focus");
    expect(fullBody.uc).toContain("plastic skin");
  });

  it("starts each Character Prompt with its NovelAI subject binding", () => {
    const catalog = loadPromptCatalog();
    const female = composePrompt(catalog, {
      characterId: "yoon_seo_a",
      formatId: "sprite_full_body",
      situationId: "reference_social_smile",
    });
    const male = composePrompt(catalog, {
      characterId: "han_do_yoon",
      variantId: "reality",
      formatId: "sprite_full_body",
      situationId: "reference_waiting_smile",
    });

    expect(female.character.startsWith("girl, ")).toBe(true);
    expect(male.character.startsWith("boy, ")).toBe(true);
    expect(male.character.match(/(^|, )boy(?=,|$)/g)).toHaveLength(1);
  });

  it("uses NovelAI automatic quality tags without duplicating manual quality tags", () => {
    const catalog = loadPromptCatalog();
    const prompt = composePrompt(catalog, {
      characterId: "cha_min_kyung",
      formatId: "meeting_room",
      situationId: "meeting_fact_check",
    });

    expect(prompt.base).not.toContain("masterpiece");
    expect(prompt.base).toContain("game cg, year 2024");
    expect(prompt.base).not.toContain("bright pupils");
    expect(prompt.base).not.toContain("best quality");
    expect(prompt.base).not.toContain("absurdres");
  });

  it("keeps the adult bishoujo body direction in female character files only", () => {
    const catalog = loadPromptCatalog();

    for (const character of catalog.characters) {
      for (const variant of character.variants) {
        if (character.subject === "female") {
          expect(variant.identityTags).toContain("1.2::exceptionally beautiful face, refined elegant facial features::");
          expect(variant.identityTags).toContain("large breasts");
          expect(variant.identityTags).toContain("breasts");
          expect(variant.identityTags).not.toContain("girl");
          expect(variant.characterUndesiredTags).toContain("flat chest");
          expect(variant.characterUndesiredTags).toContain("small breasts");
          expect(variant.characterUndesiredTags).not.toContain("large breasts");
        } else {
          expect(variant.identityTags).not.toContain("large breasts");
          expect(variant.characterUndesiredTags).not.toContain("flat chest");
        }
      }
    }

    expect(catalog.sharedUndesiredTags).not.toContain("large breasts");
    expect(catalog.sharedUndesiredTags).not.toContain("huge breasts");
    expect(catalog.sharedUndesiredTags).not.toContain("gigantic breasts");
    expect(catalog.sharedUndesiredTags).not.toContain("cleavage");
    expect(catalog.sharedUndesiredTags).toContain("heterochromia");
    expect(catalog.sharedUndesiredTags).toContain("multicolored eyes");
    expect(catalog.sharedUndesiredTags).not.toContain("giant eyes");
    expect(catalog.sharedUndesiredTags).not.toContain("galaxy eyes");
  });

  it("copies only the supplied art style and never its character or battle content", () => {
    const catalog = loadPromptCatalog();
    const forbiddenContent = [
      "pink hair",
      "pink eyes",
      "bright pupils",
      "cyborg",
      "bikini armor",
      "mechanical wings",
      "detached wings",
      "holding sword",
      "energy sword",
      "incoming attack",
      "attack trail",
      "blurry foreground",
      "motion blur",
      "dynamic pose",
      "running",
      "above clouds",
      "battle",
      "year 2020",
      "HDR",
      "cinematic lighting",
      "soft shadow",
      "pastel colors",
      "rough sketch",
      "manga style",
      "anime coloring",
      "lineart",
    ];

    const secondReferenceContent = [
      "white frilly dress",
      "sitting by window",
      "morning glories",
      "lace curtains",
      "bare feet",
      "purple eyes",
      "flower accessory",
      "sailor uniform",
      "waving hand",
      "schoolyard",
      "cloudy",
      "cover page",
      "nurse",
      "latex gloves",
      "very long hair",
      "red eyes",
      "red hair",
      "black pantyhose",
      "skinny",
      "crossed legs",
      "photo background",
      "hospital",
      "sunlight",
      "lens flare",
    ];

    for (const forbidden of secondReferenceContent) {
      expect(catalog.styleTags).not.toContain(forbidden);
    }

    for (const character of catalog.characters) {
      for (const variant of character.variants) {
        for (const situation of variant.situations) {
          const prompt = composePrompt(catalog, {
            characterId: character.id,
            variantId: variant.id,
            situationId: situation.id,
          });
          expect(prompt.base).toContain("game cg, year 2024");
          for (const forbidden of forbiddenContent) {
            expect(prompt.combined).not.toContain(forbidden);
          }
        }
      }
    }
  });

  it("keeps Han Do-yoon's reality and perceived looks isolated", () => {
    const catalog = loadPromptCatalog();
    const reality = composePrompt(catalog, {
      characterId: "han_do_yoon",
      variantId: "reality",
      situationId: "reference_waiting_smile",
    });
    const perceived = composePrompt(catalog, {
      characterId: "han_do_yoon",
      variantId: "perceived",
      situationId: "perceived_confident",
    });

    expect(reality.character).toContain("receding hairline");
    expect(reality.character).toContain("protruding belly");
    expect(reality.character).not.toContain("handsome middle-aged man");
    expect(perceived.character).toContain("handsome middle-aged man");
    expect(perceived.character).toContain("sharp jawline");
    expect(perceived.character).not.toContain("receding hairline");
  });

  it("keeps Im Soo-yeon's current and bookstore looks isolated", () => {
    const catalog = loadPromptCatalog();
    const current = composePrompt(catalog, {
      characterId: "im_soo_yeon",
      variantId: "current",
      situationId: "current_testimony",
    });
    const past = composePrompt(catalog, {
      characterId: "im_soo_yeon",
      variantId: "past_bookstore",
      situationId: "bookstore_service",
    });

    expect(current.character).toContain("short softly wavy brown hair");
    expect(current.character).toContain("thin round glasses");
    expect(current.character).not.toContain("shoulder-length naturally wavy brown hair");
    expect(past.character).toContain("shoulder-length naturally wavy brown hair");
    expect(past.character).toContain("no glasses");
    expect(past.character).not.toContain("thin round glasses");
  });
});
