#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PROJECT_ROOT = resolve(import.meta.dirname, "..");
export const PROMPT_CONFIG_ROOT = resolve(PROJECT_ROOT, "prompt-config/novelai-v45");

const TAG_FIELD_NAMES = new Set([
  "styleTags",
  "manualQualityTags",
  "sharedUndesiredTags",
  "tags",
  "female",
  "male",
  "identityTags",
  "outfitTags",
  "fullBodyOnlyTags",
  "characterUndesiredTags",
  "undesiredTags",
]);

export function unwrapPromptItem(item) {
  const weighted = item.match(/^\s*-?(?:\d+(?:\.\d+)?)::([\s\S]+)::\s*$/);
  return (weighted ? weighted[1] : item)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function collectTagItems(value, path = "$") {
  const results = [];
  if (!value || typeof value !== "object") return results;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (TAG_FIELD_NAMES.has(key) && Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (typeof item !== "string") continue;
        for (const tag of unwrapPromptItem(item)) {
          results.push({ tag, path: `${childPath}[${index}]` });
        }
      }
      continue;
    }
    results.push(...collectTagItems(child, childPath));
  }
  return results;
}

function buildUsageIndex(items) {
  const usages = new Map();
  for (const item of items) {
    const locations = usages.get(item.tag) || [];
    locations.push(`${item.file} ${item.path}`);
    usages.set(item.tag, locations);
  }
  return usages;
}

export async function loadPromptTagAudit({
  root = PROJECT_ROOT,
  configRoot = PROMPT_CONFIG_ROOT,
} = {}) {
  const characterDirectory = resolve(configRoot, "characters");
  const characterFiles = (await readdir(characterDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => resolve(characterDirectory, name));
  const files = [resolve(configRoot, "defaults.json"), ...characterFiles];
  const items = [];
  for (const file of files) {
    const config = JSON.parse(await readFile(file, "utf8"));
    for (const item of collectTagItems(config)) {
      items.push({ ...item, file: file.slice(root.length + 1) });
    }
  }

  const registry = JSON.parse(await readFile(resolve(configRoot, "tag-registry.json"), "utf8"));
  const usages = buildUsageIndex(items);
  const tags = [...usages.keys()].sort((left, right) => left.localeCompare(right));
  const registryTags = Array.isArray(registry.tags) ? registry.tags : [];
  const registered = new Set(registryTags.map((entry) => entry?.tag).filter(Boolean));
  return {
    items,
    registry,
    tags,
    usages,
    unregistered: tags.filter((tag) => !registered.has(tag)),
  };
}

export function parsePublicTagCsv(csv) {
  const publicTags = new Map();
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawName, category, rawCount] = line.split(",", 3);
    const tag = rawName.replace(/^"|"$/g, "").replaceAll("_", " ");
    if (tag === "tag") continue;
    publicTags.set(tag, { category, count: Number(rawCount) || 0 });
  }
  return publicTags;
}

async function readStdin() {
  return new Promise((resolveInput, rejectInput) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolveInput(input));
    process.stdin.on("error", rejectInput);
  });
}

export async function runAuditCli(argv = process.argv.slice(2)) {
  const audit = await loadPromptTagAudit();

  if (argv.includes("--registry")) {
    console.log(audit.unregistered.join("\n"));
    console.error(`\nunregistered=${audit.unregistered.length}`);
    return audit.unregistered.length ? 1 : 0;
  }

  const csvFlag = argv.indexOf("--csv");
  if (csvFlag < 0 || !argv[csvFlag + 1]) {
    console.log(audit.tags.join("\n"));
    console.error(`\n${audit.tags.length} unique prompt tag candidates. Add --csv <public-danbooru-tags.csv> to verify locally.`);
    return 0;
  }

  const csvArgument = argv[csvFlag + 1];
  const csv = csvArgument === "-"
    ? await readStdin()
    : await readFile(resolve(process.cwd(), csvArgument), "utf8");
  const publicTags = parsePublicTagCsv(csv);
  const verified = audit.tags.filter((tag) => publicTags.has(tag));
  const unverified = audit.tags.filter((tag) => !publicTags.has(tag));
  console.log(JSON.stringify({
    verified: verified.map((tag) => ({
      tag,
      count: publicTags.get(tag).count,
      category: publicTags.get(tag).category,
    })),
    unverified: unverified.map((tag) => ({
      tag,
      usages: audit.usages.get(tag),
    })),
  }, null, 2));
  console.error(`\nverified=${verified.length} unverified=${unverified.length}`);
  return 0;
}

const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exitCode = await runAuditCli();
}
