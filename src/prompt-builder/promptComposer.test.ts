import { describe, expect, it } from "vitest";
import { loadPromptCatalog, parsePromptCatalog } from "./promptCatalog";
import { composePrompt, exactDedupe, splitPromptText } from "./promptComposer";
import type { PromptRuntimeMetadata } from "./types";

describe("NovelAI prompt catalog", () => {
  it("loads character files and joins canonical runtime metadata", () => {
    const catalog = loadPromptCatalog();
    const seoA = catalog.characters.find((character) => character.id === "yoon_seo_a");
    const minKyung = catalog.characters.find((character) => character.id === "cha_min_kyung");

    expect(catalog.characters).toHaveLength(5);
    expect(catalog.styleTags).toEqual([
      "visual novel",
      "year 2024",
    ]);
    expect(catalog.styleInstructions).toEqual(expect.arrayContaining([
      expect.stringContaining("commercial game CG"),
      expect.stringContaining("soft cel shading"),
    ]));
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
      role: "영업기획팀 계약직 사원",
      conceptArt: "assets/characters/yoon-seo-a/office-default/base-cutout.png",
    });
    expect(seoA?.variants[0].identityTags).toContain("long hair");
    expect(seoA?.variants[0].identityInstructions.join(" ")).toContain("dark-brown hair");
    expect(seoA?.variants[0].identityTags).toContain("1.2::large breasts::");
    expect(minKyung?.referenceImages).toEqual([{
      id: "mole-placement-reference",
      label: "점 위치 보강 원화",
      path: "assets/concept-art/cha-min-kyung-reference-2.png",
    }]);
    expect(catalog.tagRegistry.sources.map(({ id }) => id)).toEqual([
      "novelai_official",
      "danbooru_tag_tool",
    ]);
  });

  it("reports the source file and JSON path for an invalid reference", () => {
    const defaults = JSON.stringify({
      schemaVersion: 2,
      model: "test",
      settings: {
        qualityTags: false,
        ucPreset: "test",
        guidance: "5–6",
        steps: "28",
        samplers: ["Euler Ancestral"],
        variety: false,
        noiseSchedule: "Recommended",
        promptGuidanceRescale: "0",
      },
      styleTags: ["visual novel"],
      styleInstructions: ["Use a visual-novel finish."],
      manualQualityTags: ["masterpiece"],
      sharedUndesiredTags: ["3d"],
      sharedUndesiredInstructions: [],
      basePresets: [{
        id: "sprite_full_body",
        label: "sprite",
        description: "test",
        subjectTags: { female: ["1girl"], male: ["1boy"] },
        tags: ["full body"],
        instructions: [],
      }],
    });
    const invalidCharacter = JSON.stringify({
      schemaVersion: 2,
      characterId: "test_character",
      order: 10,
      subject: "female",
      accent: "#fff",
      defaultLookId: "missing",
      looks: [{
        id: "default",
        label: "default",
        identityTags: ["long hair"],
        identityInstructions: [],
        outfitTags: ["shirt"],
        outfitInstructions: [],
        fullBodyOnlyTags: [],
        fullBodyOnlyInstructions: [],
        characterUndesiredTags: [],
        characterUndesiredInstructions: [],
        inpaintTasks: [],
        defaultSituationId: "neutral",
        situations: [{
          id: "neutral",
          label: "neutral",
          basePresetId: "sprite_full_body",
          tags: ["standing"],
          instructions: [],
          undesiredTags: [],
          undesiredInstructions: [],
        }],
      }],
    });
    const registry = JSON.stringify({
      schemaVersion: 1,
      sources: [{
        id: "test",
        label: "test",
        url: "https://example.com",
        checkedAt: "2026-08-02",
        description: "test source",
      }],
      tags: [
        "1girl", "1boy", "visual novel", "masterpiece", "3d",
        "full body", "long hair", "shirt", "standing",
      ].map((tag) => ({ tag, sourceId: "test" })),
    });
    const runtime: PromptRuntimeMetadata = { characters: {} };

    expect(() => parsePromptCatalog({
      defaults: { "../../prompt-config/novelai-v45/defaults.json": defaults },
      characters: {
        "../../prompt-config/novelai-v45/characters/test_character.json": invalidCharacter,
      },
      registry: { "../../prompt-config/novelai-v45/tag-registry.json": registry },
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
      extraTags: "girl, 1.2::holding, book::, girl",
    });
    const cropped = composePrompt(catalog, {
      characterId: "yoon_seo_a",
      variantId: "office",
      formatId: "office_desk",
      situationId: "reference_social_smile",
    });

    expect(fullBody.base).toContain("1girl, solo, full body");
    expect(fullBody.character.startsWith("girl, brown hair, ")).toBe(true);
    expect(fullBody.character).toContain("long hair");
    expect(fullBody.character).toContain("dark-brown hair");
    expect(fullBody.character).toContain("1.2::large breasts::, breasts");
    expect(fullBody.character).toContain("1.2::holding, book::");
    expect(fullBody.character).toContain("black loafers");
    expect(cropped.character).not.toContain("black loafers");
    expect(fullBody.combined).toBe(`${fullBody.base} | ${fullBody.character}`);
    expect(fullBody.uc).not.toContain("Human Focus");
    expect(fullBody.uc).toContain("Plastic-looking");
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
    expect(prompt.base).toContain("visual novel, year 2024");
    expect(prompt.base).toContain("commercial game CG");
    expect(prompt.base).toContain("soft cel shading");
    expect(prompt.base).toContain("clear detailed eyes");
    expect(prompt.base).not.toContain("bright pupils");
    expect(prompt.base).not.toContain("best quality");
    expect(prompt.base).not.toContain("absurdres");
  });

  it("adds the five verified common expressions to every character look", () => {
    const catalog = loadPromptCatalog();
    const commonIds = [
      "common_stern_glare",
      "common_anger",
      "common_disgust",
      "common_fear",
      "common_fear_crying",
    ];
    const requiredTags: Record<string, string[]> = {
      common_stern_glare: ["serious", "closed mouth", "looking at viewer"],
      common_anger: ["angry", "scowl", "furrowed brow", "v-shaped eyebrows", "open mouth"],
      common_disgust: ["disgust", "grimace", "closed mouth"],
      common_fear: ["scared", "wide-eyed", "open mouth", "sweat", "trembling"],
      common_fear_crying: [
        "scared",
        "crying",
        "crying with eyes open",
        "tears",
        "wide-eyed",
        "open mouth",
        "trembling",
      ],
    };

    expect(catalog.commonSituations.map(({ id }) => id)).toEqual(commonIds);
    for (const common of catalog.commonSituations) {
      expect(common.source).toBe("prompt-config/novelai-v45/defaults.json");
      expect(common.basePresetId).toBe("character_upper_body");
      expect(common.instructions).toContain(
        "Keep all established face, hair, body, outfit, accessory, prop, and rendering details unchanged.",
      );
      expect(common.tags).toEqual(expect.arrayContaining(requiredTags[common.id]));
    }

    for (const character of catalog.characters) {
      for (const variant of character.variants) {
        const variantCommonIds = variant.situations
          .filter(({ id }) => id.startsWith("common_"))
          .map(({ id }) => id);
        expect(variantCommonIds).toEqual(commonIds);
        for (const commonId of commonIds) {
          const prompt = composePrompt(catalog, {
            characterId: character.id,
            variantId: variant.id,
            situationId: commonId,
          });
          expect(prompt.audit.positiveTagItems).toEqual(
            expect.arrayContaining(requiredTags[commonId]),
          );
          expect(prompt.combined).toContain("Keep all established face, hair, body, outfit");
        }
      }
    }

    const stern = composePrompt(catalog, {
      characterId: "cha_min_kyung",
      situationId: "common_stern_glare",
    });
    expect(stern.audit.positiveTagItems).not.toContain("angry");
    expect(stern.audit.positiveTagItems).not.toContain("scowl");
    expect(stern.audit.positiveTagItems).not.toContain("furrowed brow");
    expect(stern.audit.undesiredTagItems).toEqual(expect.arrayContaining([
      "angry",
      "scowl",
      "furrowed brow",
      "v-shaped eyebrows",
      "open mouth",
    ]));

    const anger = composePrompt(catalog, {
      characterId: "cha_min_kyung",
      situationId: "common_anger",
    });
    expect(anger.audit.positiveTagItems).toEqual(expect.arrayContaining([
      "angry",
      "scowl",
      "furrowed brow",
      "v-shaped eyebrows",
    ]));
    expect(anger.audit.undesiredTagItems).not.toContain("angry");
    expect(anger.audit.undesiredTagItems).not.toContain("scowl");
    expect(anger.audit.undesiredTagItems).not.toContain("furrowed brow");
    expect(anger.audit.undesiredTagItems).not.toContain("v-shaped eyebrows");
  });

  it("preserves every accepted identity, outfit, and art-style anchor in every situation", () => {
    const catalog = loadPromptCatalog();

    for (const character of catalog.characters) {
      for (const variant of character.variants) {
        const outfit = variant.outfits.find(({ id }) => id === variant.defaultOutfitId);
        expect(outfit).toBeDefined();
        for (const situation of variant.situations) {
          const prompt = composePrompt(catalog, {
            characterId: character.id,
            variantId: variant.id,
            situationId: situation.id,
          });
          for (const tag of [...catalog.styleTags, ...variant.identityTags, ...(outfit?.tags ?? [])]) {
            expect(prompt.audit.positiveTagItems).toContain(tag);
          }
          for (const instruction of [
            ...catalog.styleInstructions,
            ...variant.identityInstructions,
            ...(outfit?.instructions ?? []),
          ]) {
            expect(prompt.audit.positiveInstructions).toContain(instruction);
          }
        }
      }
    }
  });

  it("uses concrete female facial morphology instead of a subjective beauty phrase", () => {
    const catalog = loadPromptCatalog();
    const femaleTagAnchors = ["long eyelashes"];
    const femaleInstructionAnchors = ["small nose", "soft full lips"];
    const exactCount = (items: readonly string[], expected: string) => (
      items.filter((item) => item === expected).length
    );

    for (const character of catalog.characters) {
      for (const variant of character.variants) {
        if (character.subject === "female") {
          for (const tag of femaleTagAnchors) {
            expect(exactCount(variant.identityTags, tag)).toBe(1);
          }
          for (const phrase of femaleInstructionAnchors) {
            expect(variant.identityInstructions.join(" ")).toContain(phrase);
          }
          expect(variant.identityTags.join(", ")).not.toContain("exceptionally beautiful");
          expect(variant.identityTags.join(", ")).not.toContain("beautiful face");
          expect(variant.identityTags).not.toContain("flat chest");
          expect(variant.identityTags).not.toContain("small breasts");
          expect(variant.identityTags).not.toContain("girl");
          expect(variant.characterUndesiredTags).toContain("flat chest");
          expect(variant.characterUndesiredTags).toContain("small breasts");
          for (const situation of variant.situations) {
            const prompt = composePrompt(catalog, {
              characterId: character.id,
              variantId: variant.id,
              situationId: situation.id,
            });
            const characterItems = splitPromptText(prompt.character);
            const ucItems = splitPromptText(prompt.uc);
            for (const tag of femaleTagAnchors) {
              expect(exactCount(characterItems, tag)).toBe(1);
              expect(exactCount(ucItems, tag)).toBe(0);
            }
            for (const phrase of femaleInstructionAnchors) {
              expect(prompt.character).toContain(phrase);
            }
            expect(prompt.character).not.toContain("exceptionally beautiful");
            expect(prompt.character).not.toContain("beautiful face");
          }
        } else {
          for (const tag of femaleTagAnchors) {
            expect(exactCount(variant.identityTags, tag)).toBe(0);
          }
          for (const phrase of femaleInstructionAnchors) {
            expect(variant.identityInstructions.join(" ")).not.toContain(phrase);
          }
          expect(variant.characterUndesiredTags).not.toContain("flat chest");
          expect(variant.characterUndesiredTags).not.toContain("small breasts");
        }
      }
    }
  });

  it("keeps each heroine's bust proportionate while preserving Kang Yoo-jin's curvy silhouette", () => {
    const catalog = loadPromptCatalog();
    const standardBodyTags = ["narrow waist", "1.2::large breasts::", "breasts"];
    const minKyungBodyTags = ["narrow waist", "1.25::large breasts::", "cleavage", "breasts"];
    const yooJinBodyTags = [
      "curvy",
      "narrow waist",
      "wide hips",
      "long legs",
      "slim legs",
      "1.1::medium breasts::",
      "breasts",
    ];
    const yooJinUniqueBodyTags = ["curvy", "wide hips", "long legs", "slim legs"];
    const exactCount = (items: readonly string[], expected: string) => (
      items.filter((item) => item === expected).length
    );

    for (const character of catalog.characters.filter(({ subject }) => subject === "female")) {
      for (const variant of character.variants) {
        const expectedTags = character.id === "kang_yoo_jin"
          ? yooJinBodyTags
          : character.id === "cha_min_kyung"
            ? minKyungBodyTags
            : standardBodyTags;
        for (const tag of expectedTags) {
          expect(exactCount(variant.identityTags, tag)).toBe(1);
        }
        if (character.id === "kang_yoo_jin") {
          expect(variant.identityTags).toContain("1.1::medium breasts::");
        } else {
          expect(variant.identityTags).not.toContain("1.1::medium breasts::");
        }
        expect(variant.characterUndesiredTags).toContain("flat chest");
        expect(variant.characterUndesiredTags).toContain("small breasts");

        if (character.id === "kang_yoo_jin") {
          expect(variant.identityTags).not.toContain("1.3::narrow waist::");
          expect(variant.identityTags).not.toContain("1.3::huge breasts::");
          expect(variant.identityTags).not.toContain("1.2::large breasts::");
          expect(variant.identityTags).not.toContain("large breasts");
          expect(variant.identityTags).not.toContain("tall female");
          expect(variant.identityTags).toContain("long hair");
          expect(variant.identityTags).toContain("pink eyes");
          expect(variant.identityTags).not.toContain("aqua eyes");
          expect(variant.identityTags).not.toContain("black eyes");
          expect(variant.outfits[0]?.tags).toContain("white shirt");
          expect(variant.outfits[0]?.tags).not.toContain("blue shirt");
          expect(variant.outfits[0]?.instructions.join(" ")).toContain("fitted pure-white button-up shirt");
          expect(variant.outfits[0]?.instructions.join(" ")).toContain("neutral white without blue, gray, cream, beige, or colored tint");
          expect(variant.outfits[0]?.instructions.join(" ")).toContain("high-waisted light-gray wide-leg trousers");
          expect(variant.identityInstructions.join(" ")).toContain("medium-full proportionate bust");
          expect(variant.identityInstructions.join(" ")).toContain("clean contemporary visual-novel character rendering");
          expect(variant.characterUndesiredTags).toContain("huge breasts");
          expect(variant.characterUndesiredInstructions.join(" ")).toContain("Breasts larger than her head");
          expect(variant.characterUndesiredInstructions.join(" ")).toContain("fragile anatomy");
          expect(variant.characterUndesiredTags).toContain("ribs");
          expect(variant.characterUndesiredTags).toContain("blue shirt");
          const lobbySituation = variant.situations.find(({ id }) => id === "reference_fact_check");
          expect(lobbySituation).toMatchObject({
            label: "기본 로비 자신감",
            basePresetId: "character_upper_body",
          });
          expect(lobbySituation?.tags).toEqual(expect.arrayContaining(["smile", "closed mouth", "looking at viewer"]));
          expect(lobbySituation?.tags).not.toContain("raised eyebrow");
          const lobbyPrompt = composePrompt(catalog, {
            characterId: character.id,
            variantId: variant.id,
            situationId: "reference_fact_check",
          });
          expect(lobbyPrompt.base).toContain("upper body");
          expect(lobbyPrompt.base).toContain("grey background");
          expect(lobbyPrompt.character).toContain("1.1::medium breasts::");
          expect(lobbyPrompt.character).toContain("medium-full proportionate bust");
          expect(lobbyPrompt.character).toContain("white shirt");
          expect(lobbyPrompt.character).toContain("pink eyes");
          expect(lobbyPrompt.character).toContain("vivid clear rose-pink irises");
          expect(lobbyPrompt.character).not.toContain("aqua eyes");
          expect(lobbyPrompt.character).not.toContain("black eyes");
          expect(lobbyPrompt.character).not.toContain("blue shirt");
          expect(lobbyPrompt.character).not.toContain("huge breasts");
          expect(lobbyPrompt.uc).toContain("huge breasts");
          expect(lobbyPrompt.uc).toContain("aqua eyes");
          expect(lobbyPrompt.uc).toContain("black eyes");
          expect(lobbyPrompt.combined.length).toBeLessThan(1800);
          expect(variant.situations.find(({ id }) => id === "reference_dimple_smile")).toBeUndefined();
          expect(variant.situations.find(({ id }) => id === "reference_cupids_bow_lips")).toBeUndefined();
          const appearanceCandidates = [
            {
              id: "reference_asymmetric_eye_smile",
              label: "외모 후보 C · 눈웃음과 입꼬리",
              positive: "crescent-shaped smiling eyes",
              negative: "Staring eyes",
            },
          ];
          for (const candidate of appearanceCandidates) {
            const situation = variant.situations.find(({ id }) => id === candidate.id);
            expect(situation).toMatchObject({
              label: candidate.label,
              basePresetId: "character_upper_body",
            });
            expect(situation?.tags).toEqual(expect.arrayContaining([
              "smile",
              "closed mouth",
              "looking at viewer",
            ]));
            if (candidate.id === "reference_asymmetric_eye_smile") {
              expect(situation?.tags).toContain("half-closed eyes");
            }
            expect(situation?.instructions.join(" ")).toContain(candidate.positive);
            expect(situation?.undesiredInstructions.join(" ")).toContain(candidate.negative);
            const candidatePrompt = composePrompt(catalog, {
              characterId: character.id,
              variantId: variant.id,
              situationId: candidate.id,
            });
            expect(candidatePrompt.base).toContain("upper body");
            expect(candidatePrompt.character).toContain(candidate.positive);
            expect(candidatePrompt.character).toContain("pink eyes");
            expect(candidatePrompt.character).not.toContain("aqua eyes");
            expect(candidatePrompt.character).not.toContain("black eyes");
            expect(candidatePrompt.uc).toContain(candidate.negative);
            expect(candidatePrompt.combined.length).toBeLessThan(1800);
          }
          expect(variant.situations.find(({ id }) => id === "reference_jet_black_eyes")).toBeUndefined();
          expect(variant.situations.find(({ id }) => id === "reference_pink_eyes")).toBeUndefined();
          expect(variant.inpaintTasks).toHaveLength(2);
          expect(variant.inpaintTasks[0]).toMatchObject({
            id: "left_smile_dimple",
            label: "후보 A 확정 · 왼쪽 보조개 Inpaint",
          });
          expect(variant.inpaintTasks[0]?.tags).toEqual(["smile", "closed mouth"]);
          expect(variant.inpaintTasks[0]?.instructions.join(" ")).toContain(
            "1.5::exactly one clearly visible shallow smile dimple",
          );
          expect(variant.inpaintTasks[1]).toMatchObject({
            id: "natural_cupids_bow",
            label: "후보 B 확정 · 큐피드 보우 입술 Inpaint",
          });
          expect(variant.inpaintTasks[1]?.tags).toEqual(["closed mouth"]);
          expect(variant.inpaintTasks[1]?.instructions.join(" ")).toContain(
            "1.5::a clearly visible natural Cupid's bow",
          );
          expect(catalog.sharedUndesiredTags).not.toContain("earrings");
          for (const outfit of variant.outfits) {
            expect(outfit.tags).not.toContain("earrings");
            expect(outfit.instructions.join(" ").toLowerCase()).not.toContain("earring");
          }
          const minKyung = catalog.characters.find(({ id }) => id === "cha_min_kyung");
          expect(minKyung?.variants[0]?.outfits[0]?.tags).toContain("earrings");
          expect(minKyung?.variants[0]?.outfits[0]?.instructions.join(" ")).toContain("thin metal earrings");
        } else if (character.id === "cha_min_kyung") {
          expect(variant.identityTags).not.toContain("1.2::large breasts::");
          expect(variant.identityTags).not.toContain("1.2::huge breasts::");
          expect(variant.outfits[0]?.tags).toContain("open jacket");
          expect(variant.identityInstructions.join(" ")).toContain("naturally close-set without merging");
          expect(variant.outfits[0]?.instructions.join(" ")).toContain("open to frame her silhouette");
          expect(variant.outfits[0]?.instructions.join(" ")).toContain("deep soft cel-shaded shadow");
          expect(variant.characterUndesiredInstructions.join(" ")).toContain("merged breast mass");
        } else {
          for (const tag of yooJinUniqueBodyTags) {
            expect(variant.identityTags).not.toContain(tag);
          }
        }

        for (const situation of variant.situations) {
          const prompt = composePrompt(catalog, {
            characterId: character.id,
            variantId: variant.id,
            situationId: situation.id,
          });
          const characterItems = splitPromptText(prompt.character);
          const ucItems = splitPromptText(prompt.uc);
          for (const tag of expectedTags) {
            expect(exactCount(characterItems, tag)).toBe(1);
            expect(exactCount(ucItems, tag)).toBe(0);
          }
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

  it("keeps Yoon Seo-a's large eyes and applies her signature eye-smile only to smile situations", () => {
    const catalog = loadPromptCatalog();
    const seoA = catalog.characters.find(({ id }) => id === "yoon_seo_a");
    const variant = seoA?.variants[0];
    const socialSmile = variant?.situations.find(({ id }) => id === "reference_social_smile");
    const relief = variant?.situations.find(({ id }) => id === "relief_with_coworker");
    const tense = variant?.situations.find(({ id }) => id === "tense_at_doorway");

    expect(variant?.identityTags).toEqual(expect.arrayContaining([
      "brown hair",
      "long hair",
      "wavy hair",
      "brown eyes",
      "petite",
    ]));
    expect(variant?.identityInstructions.join(" ")).toEqual(expect.stringContaining(
      "very large round brown eyes",
    ));
    expect(variant?.identityInstructions.join(" ")).toEqual(expect.stringContaining(
      "small rounded oval face",
    ));
    expect(variant?.characterUndesiredTags).toEqual(expect.arrayContaining([
      "sunken cheeks",
      "bags under eyes",
    ]));
    expect(variant?.characterUndesiredInstructions.join(" ")).toContain("nasolabial folds");
    expect(variant?.characterUndesiredInstructions.join(" ")).toContain("heavy makeup");
    expect(socialSmile).toMatchObject({ basePresetId: "character_upper_body" });
    expect(socialSmile?.tags).toEqual(expect.arrayContaining([
      "looking at viewer",
    ]));
    expect(socialSmile?.instructions.join(" ")).toContain("subtle eye smile");
    expect(socialSmile?.instructions.join(" ")).not.toContain("visible teeth");
    expect(relief?.tags).toEqual(expect.arrayContaining([
      "half-closed eyes",
      "teeth",
    ]));
    expect(relief?.instructions.join(" ")).toContain("subtle gummy smile");
    expect(tense?.instructions.join(" ")).not.toContain("gummy smile");

    const defaultPrompt = composePrompt(catalog, {
      characterId: "yoon_seo_a",
      variantId: "office",
      situationId: "reference_social_smile",
    });
    expect(defaultPrompt.base).toContain("upper body");
    expect(defaultPrompt.character).toContain("very large round brown eyes");
    expect(defaultPrompt.character).toContain("small rounded oval face");
    expect(defaultPrompt.uc).toContain("nasolabial folds");
    expect(defaultPrompt.uc).toContain("bags under eyes");

    const allPromptConfig = catalog.characters.flatMap((character) => (
      character.variants.flatMap((look) => [
        ...look.identityTags,
        ...look.outfits.flatMap((outfit) => outfit.tags),
        ...look.characterUndesiredTags,
        ...look.situations.flatMap((situation) => situation.tags),
      ])
    )).join(", ");
    expect(allPromptConfig).not.toMatch(/baek\s*ji[- ]?heon|백지헌/i);
  });

  it("restores Cha Min-kyung's compact stable prompt and keeps later mark experiments in Inpaint", () => {
    const catalog = loadPromptCatalog();
    const minKyung = catalog.characters.find(({ id }) => id === "cha_min_kyung");
    const variant = minKyung?.variants[0];
    const defaultSituation = variant?.situations.find(({ id }) => id === "reference_skeptical");

    expect(variant?.identityTags).toContain("1.35::mole under eye::");
    expect(variant?.identityTags).toContain("1.35::mole on collarbone::");
    expect(variant?.identityTags).not.toContain("1.25::mole on neck::");
    expect(variant?.identityInstructions.join(" ")).toContain("sleek chin-length black bob");
    expect(variant?.identityInstructions.join(" ")).toContain("large almond-shaped reddish-brown eyes");
    expect(variant?.identityInstructions.join(" ")).toContain("small oval face");
    expect(variant?.identityInstructions.join(" ")).toContain("below the outer corner of her left eye");
    expect(variant?.identityInstructions.join(" ")).toContain("left base of her neck just below the collarbone");
    expect(variant?.identityTags).toEqual(expect.arrayContaining(["1.25::large breasts::", "cleavage"]));
    expect(variant?.identityTags).not.toContain("breasts apart");
    expect(variant?.outfits[0]?.tags).toEqual(expect.arrayContaining(["open jacket", "v-neck", "collarbone"]));
    expect(variant?.outfits[0]?.tags).not.toContain("open collar");
    expect(variant?.characterUndesiredTags).not.toContain("multiple moles");
    expect(variant?.characterUndesiredTags).not.toContain("mole on breast");
    expect(defaultSituation).toMatchObject({ basePresetId: "character_upper_body" });
    expect(defaultSituation?.tags).toEqual(expect.arrayContaining(["closed mouth", "looking at viewer"]));
    expect(defaultSituation?.tags).not.toContain("smile");
    expect(defaultSituation?.instructions.join(" ")).toContain("calm eyes");
    expect(defaultSituation?.instructions.join(" ")).toContain("relaxed eyebrows");

    const harshExpressionTags = [
      "one eyebrow raised",
      "skeptical expression",
      "clenched jaw",
      "narrowed eyes",
      "cold gaze",
      "challenging gaze",
      "tight closed mouth",
    ];
    const allSituationTags = variant?.situations.flatMap(({ tags }) => tags) ?? [];
    for (const tag of harshExpressionTags) {
      expect(allSituationTags).not.toContain(tag);
    }

    for (const character of catalog.characters.filter(({ id }) => id !== "cha_min_kyung")) {
      for (const look of character.variants) {
        expect(look.identityTags.join(", ")).not.toContain("mole under eye");
        expect(look.identityTags.join(", ")).not.toContain("mole on neck");
        expect(look.identityTags.join(", ")).not.toContain("mole on collarbone");
      }
    }

    const prompt = composePrompt(catalog, {
      characterId: "cha_min_kyung",
      variantId: "office",
      situationId: "reference_skeptical",
    });
    expect(prompt.base).toContain("upper body");
    expect(prompt.base).toContain("visual novel, year 2024");
    expect(prompt.base).toContain("soft cel shading");
    expect(prompt.character).toContain("1.35::mole under eye::");
    expect(prompt.character).toContain("below the outer corner of her left eye");
    expect(prompt.character).toContain("1.35::mole on collarbone::");
    expect(prompt.character).toContain("left base of her neck just below the collarbone");
    expect(prompt.character).toContain("1.25::large breasts::");
    expect(prompt.character).toContain("cleavage");
    expect(prompt.character).not.toContain("huge breasts");
    expect(prompt.character).not.toContain("breasts apart");
    expect(prompt.character).toContain("open jacket");
    expect(prompt.character).toContain("naturally close-set without merging");
    expect(prompt.character).toContain("deep soft cel-shaded shadow");
    expect(prompt.character).not.toContain("under her right eye");
    expect(prompt.character).not.toContain("1.25::mole on neck::");
    expect(prompt.uc).not.toContain("multiple moles");
    expect(prompt.uc).not.toContain("mole on breast");
    expect(prompt.uc).toContain("narrowed eyes");
    expect(prompt.uc).toContain("v-shaped eyebrows");
    expect(variant?.inpaintTasks).toHaveLength(3);
    expect(variant?.inpaintTasks[0]?.label).toBe("기존 눈물점 옆 두 번째 점 추가");
    expect(variant?.inpaintTasks[0]?.tags).toContain("1.6::mole under eye::");
    expect(variant?.inpaintTasks[0]?.instructions.join(" ")).toContain("center of the masked skin area");
    expect(variant?.inpaintTasks[0]?.instructions.join(" ")).toContain("beside the existing under-eye mark");
    expect(variant?.inpaintTasks[1]?.instructions.join(" ")).toContain("left side of her lower neck");
    expect(variant?.inpaintTasks[2]?.instructions.join(" ")).toContain("upper decolletage");
    expect(prompt.combined.length).toBeLessThan(1800);
  });

  it("copies only the supplied art style and never its character or battle content", () => {
    const catalog = loadPromptCatalog();
    const forbiddenContent = [
      "pink hair",
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
          expect(prompt.base).toContain("visual novel, year 2024");
          expect(prompt.base).toContain("commercial game CG");
          expect(prompt.base).toContain("soft cel shading");
          for (const forbidden of forbiddenContent) {
            expect(prompt.combined).not.toContain(forbidden);
          }
          if (character.id !== "kang_yoo_jin") {
            expect(prompt.combined).not.toContain("pink eyes");
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
    expect(reality.character).not.toContain("handsome Korean man");
    expect(perceived.character).toContain("handsome Korean man");
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

    expect(current.character).toContain("short hair, wavy hair");
    expect(current.character).toContain("thin round glasses");
    expect(current.character).not.toContain("shoulder-length brown hair");
    expect(past.character).toContain("naturally wavy shoulder-length brown hair");
    expect(past.character).toContain("no eyewear");
    expect(past.character).not.toContain("thin round glasses");
  });
});
