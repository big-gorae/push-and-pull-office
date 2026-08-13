import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const runtime = JSON.parse(readFileSync(new URL("../build/story-runtime.json", import.meta.url), "utf8"));
const scene = Object.values(runtime.scenes)
  .sort((left, right) => right.node_order.length - left.node_order.length)[0];
const nodeId = scene?.node_order.find((id) => typeof scene.nodes[id].line === "string");

if (!scene || !nodeId) throw new Error("No editable dialogue node found in the runtime.");

const iterations = Math.max(100, Number(process.argv[2] || 1000));
const clone = (value) => JSON.parse(JSON.stringify(value));

function legacyInputPath() {
  let current = clone(scene);
  const baseline = clone(scene);
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const next = clone(current);
    next.nodes[nodeId].line = `editor benchmark ${index}`;
    clone(current); // one undo snapshot for every keystroke
    JSON.stringify(next) !== JSON.stringify(baseline);
    current = next;
  }
  return performance.now() - startedAt;
}

function optimizedInputPath() {
  let current = clone(scene);
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const node = current.nodes[nodeId];
    const nextNode = {
      ...node,
      line: `editor benchmark ${index}`,
    };
    if (index === 0) clone(current); // one snapshot for the continuous typing group
    current = { ...current, nodes: { ...current.nodes, [nodeId]: nextNode } };
  }
  return performance.now() - startedAt;
}

// Warm both paths so startup and JIT compilation do not dominate the result.
legacyInputPath();
optimizedInputPath();
const legacyMs = legacyInputPath();
const optimizedMs = optimizedInputPath();

console.log(JSON.stringify({
  scene: scene.id,
  nodes: scene.node_order.length,
  edits: iterations,
  legacy_ms: Number(legacyMs.toFixed(2)),
  optimized_ms: Number(optimizedMs.toFixed(2)),
  speedup: Number((legacyMs / optimizedMs).toFixed(1)),
}, null, 2));
