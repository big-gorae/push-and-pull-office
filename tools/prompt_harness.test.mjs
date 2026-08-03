import assert from "node:assert/strict";
import test from "node:test";
import {
  DANBOORU_SEARCH_API,
  normalizeDanbooruTag,
  searchDanbooruTags,
  validatePromptHarness,
  validateRegistryStructure,
} from "./prompt_harness.mjs";

test("normalizes Danbooru names to NovelAI prompt spelling", () => {
  assert.equal(normalizeDanbooruTag("  Mole_Under_Eye  "), "mole under eye");
});

test("search sends one concept and parses the public tag tool response", async () => {
  let request;
  const results = await searchDanbooruTags("눈물점", {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return [{
            english_name: "mole_under_eye",
            korean_name: "눈물점",
            description: "눈 아래의 점",
            major_categories: "Character",
            minor_categories: "Face",
            count: 1234,
          }];
        },
      };
    },
  });

  assert.equal(request.url, DANBOORU_SEARCH_API);
  assert.deepEqual(JSON.parse(request.options.body), { keyword: "눈물점", page: 1 });
  assert.deepEqual(results, [{
    tag: "mole under eye",
    koreanName: "눈물점",
    description: "눈 아래의 점",
    majorCategory: "Character",
    minorCategory: "Face",
    count: 1234,
  }]);
});

test("rejects complete prompts so only individual concepts leave the machine", async () => {
  await assert.rejects(
    () => searchDanbooruTags("1girl, long hair, smile", { fetchImpl: async () => assert.fail("must not fetch") }),
    /개별 시각 개념 하나만/,
  );
});

test("requires the project Danbooru source and rejects unknown sources", () => {
  const issues = validateRegistryStructure({
    schemaVersion: 1,
    sources: [{ id: "made_up", url: "https://example.com" }],
    tags: [{ tag: "smile", sourceId: "made_up" }],
  });
  assert.ok(issues.some((issue) => issue.includes("unsupported source")));
  assert.ok(issues.some((issue) => issue.includes("Danbooru tag tool source is required")));
});

test("current prompt configuration passes the local harness", async () => {
  const result = await validatePromptHarness();
  assert.deepEqual(result.issues, []);
  assert.ok(result.usedTagCount > 0);
  assert.ok(result.sourceCounts.danbooru_tag_tool > 0);
});
