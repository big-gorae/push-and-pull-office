#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPromptTagAudit } from "./audit_novelai_prompt_tags.mjs";

export const DANBOORU_TAG_TOOL_URL = "https://danbooru-tag.mephistopheles.moe/";
export const DANBOORU_SEARCH_API = `${DANBOORU_TAG_TOOL_URL}api/search`;
const ALLOWED_SOURCE_IDS = new Set(["novelai_official", "danbooru_tag_tool"]);

export function normalizeDanbooruTag(value) {
  return value.trim().toLowerCase().replaceAll("_", " ").replace(/\s+/g, " ");
}

function assertConceptQuery(keyword) {
  const query = keyword.trim();
  if (!query) throw new Error("검색할 시각 개념을 하나 입력하세요.");
  if (query.length > 100 || /[,|\n\r]|::/.test(query)) {
    throw new Error("전체 프롬프트를 보내지 말고 쉼표 없는 개별 시각 개념 하나만 검색하세요.");
  }
  return query;
}

export async function searchDanbooruTags(keyword, {
  fetchImpl = globalThis.fetch,
  page = 1,
} = {}) {
  const query = assertConceptQuery(keyword);
  if (typeof fetchImpl !== "function") throw new Error("이 Node 런타임에는 fetch가 없습니다.");
  const response = await fetchImpl(DANBOORU_SEARCH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: query, page }),
  });
  if (!response.ok) {
    throw new Error(`Danbooru 태그 검색 실패: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("Danbooru 태그 검색기가 예상하지 못한 응답을 반환했습니다.");
  return payload.map((entry) => ({
    tag: normalizeDanbooruTag(String(entry.english_name || "")),
    koreanName: String(entry.korean_name || "").trim(),
    description: String(entry.description || "").trim(),
    majorCategory: String(entry.major_categories || "").trim(),
    minorCategory: String(entry.minor_categories || "").trim(),
    count: Number(entry.count) || 0,
  })).filter(({ tag }) => tag);
}

export function validateRegistryStructure(registry) {
  const issues = [];
  if (registry.schemaVersion !== 1) issues.push("tag-registry.json schemaVersion must be 1");

  const sourceIds = new Set();
  for (const [index, source] of (registry.sources || []).entries()) {
    if (!source?.id || sourceIds.has(source.id)) {
      issues.push(`sources[${index}] has a missing or duplicate id`);
      continue;
    }
    sourceIds.add(source.id);
    if (!ALLOWED_SOURCE_IDS.has(source.id)) {
      issues.push(`sources[${index}] uses unsupported source ${JSON.stringify(source.id)}`);
    }
    if (!source.url || !source.label || !source.description) {
      issues.push(`sources[${index}] must include label, URL, and description`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt || "")) {
      issues.push(`sources[${index}] checkedAt must use YYYY-MM-DD`);
    }
  }

  const danbooruSource = (registry.sources || []).find(({ id }) => id === "danbooru_tag_tool");
  if (!danbooruSource) {
    issues.push("Danbooru tag tool source is required");
  } else if (danbooruSource.url !== DANBOORU_TAG_TOOL_URL) {
    issues.push(`Danbooru tag tool URL must be ${DANBOORU_TAG_TOOL_URL}`);
  }

  const tags = new Set();
  for (const [index, entry] of (registry.tags || []).entries()) {
    if (!entry?.tag || tags.has(entry.tag)) {
      issues.push(`tags[${index}] has a missing or duplicate tag`);
      continue;
    }
    tags.add(entry.tag);
    if (entry.tag !== normalizeDanbooruTag(entry.tag)) {
      issues.push(`tags[${index}] ${JSON.stringify(entry.tag)} must use normalized lowercase space-separated spelling`);
    }
    if (!sourceIds.has(entry.sourceId)) {
      issues.push(`tags[${index}] ${JSON.stringify(entry.tag)} references unknown source ${JSON.stringify(entry.sourceId)}`);
    }
  }
  return issues;
}

export async function validatePromptHarness() {
  const audit = await loadPromptTagAudit();
  const issues = [
    ...validateRegistryStructure(audit.registry),
    ...audit.unregistered.map((tag) => `unregistered prompt tag: ${tag}`),
  ];
  const registrySources = Array.isArray(audit.registry.sources) ? audit.registry.sources : [];
  const registryTags = Array.isArray(audit.registry.tags) ? audit.registry.tags : [];
  const sourceCounts = Object.fromEntries(registrySources.map(({ id }) => [id, 0]));
  for (const entry of registryTags) {
    sourceCounts[entry.sourceId] = (sourceCounts[entry.sourceId] || 0) + 1;
  }
  return {
    issues,
    sourceCounts,
    usedTagCount: audit.tags.length,
    registeredTagCount: registryTags.length,
  };
}

function parseSearchArguments(argv) {
  let json = false;
  let limit = 12;
  const keywordParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      json = true;
      continue;
    }
    if (value === "--limit") {
      const rawLimit = Number(argv[index + 1]);
      if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
        throw new Error("--limit 뒤에는 1 이상의 정수를 입력하세요.");
      }
      limit = Math.min(rawLimit, 50);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`알 수 없는 검색 옵션: ${value}`);
    keywordParts.push(value);
  }
  return { json, keyword: keywordParts.join(" "), limit };
}

function printHelp() {
  console.log(`NovelAI prompt harness

Usage:
  npm run prompt:harness -- search "<one visual concept>" [--limit 12] [--json]
  npm run prompt:harness -- validate

Search sends only one short concept to ${DANBOORU_TAG_TOOL_URL}.
Never send a character profile or a complete prompt.`);
}

export async function runPromptHarnessCli(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return 0;
  }

  if (command === "validate") {
    const result = await validatePromptHarness();
    for (const issue of result.issues) console.error(`ERROR ${issue}`);
    console.log([
      `used=${result.usedTagCount}`,
      `registered=${result.registeredTagCount}`,
      `novelai=${result.sourceCounts.novelai_official || 0}`,
      `danbooru=${result.sourceCounts.danbooru_tag_tool || 0}`,
      `issues=${result.issues.length}`,
    ].join(" "));
    return result.issues.length ? 1 : 0;
  }

  if (command === "search") {
    const { json, keyword, limit } = parseSearchArguments(rest);
    const [results, audit] = await Promise.all([
      searchDanbooruTags(keyword),
      loadPromptTagAudit(),
    ]);
    const registered = new Set((audit.registry.tags || []).map(({ tag }) => tag));
    const limited = results.slice(0, limit).map((item) => ({
      ...item,
      registered: registered.has(item.tag),
    }));
    if (json) {
      console.log(JSON.stringify({ query: keyword.trim(), results: limited }, null, 2));
      return 0;
    }
    console.log(`Danbooru 태그 검색기 · ${DANBOORU_TAG_TOOL_URL}`);
    console.log(`검색: ${keyword.trim()} · 결과 ${results.length}개 중 ${limited.length}개 표시`);
    for (const [index, item] of limited.entries()) {
      const registration = item.registered ? "registered" : "new";
      console.log(`${String(index + 1).padStart(2, "0")}. ${item.tag} · ${item.koreanName || "-"} · ${item.count.toLocaleString("en-US")} · ${registration}`);
      console.log(`    ${[item.majorCategory, item.minorCategory].filter(Boolean).join(" / ") || "분류 없음"}`);
      if (item.description) console.log(`    ${item.description}`);
    }
    console.log("정확한 의미가 맞는 영문 태그만 *Tags에 사용하고, 적합한 태그가 없으면 *Instructions에 자연어로 작성하세요.");
    return 0;
  }

  console.error(`알 수 없는 명령: ${command}`);
  printHelp();
  return 2;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  try {
    process.exitCode = await runPromptHarnessCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
