import { describe, expect, it } from "vitest";
import { bundledCatalog, sceneHash, sha256, stableStringify } from "./sync";

describe("mobile authoring catalog", () => {
  it("creates a path-free, content-addressed catalog", async () => {
    const catalog = await bundledCatalog();

    expect(catalog.entries.length).toBeGreaterThan(300);
    expect(catalog.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(catalog)).not.toMatch(/(?:\/Users\/|story\/scenes\/|\.ya?ml)/);
    expect(catalog.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.valueHash))).toBe(true);
    expect(catalog.workspace?.days.length).toBeGreaterThan(1);
    expect(Object.keys(catalog.workspace?.scenes || {}).length).toBeGreaterThan(10);
    expect(catalog.workspace?.artworks.length).toBeGreaterThan(0);
    expect(catalog.workspace?.backgrounds.length).toBeGreaterThan(0);
  });

  it("keeps every dialogue entry independently owned", async () => {
    const catalog = await bundledCatalog();
    const linked = catalog.entries.filter((entry) => entry.linkedLocalizationKeys?.length);
    expect(linked).toEqual([]);
  });

  it("uses deterministic SHA-256 hashes", async () => {
    expect(await sha256("밀당 오피스")).toBe("c3b865a723234bc3b138afe48c1d431154acc0fed6de78cc14085695e210793e");
  });

  it("hashes scene documents independent of object key insertion order", async () => {
    const catalog = await bundledCatalog();
    const scene = Object.values(catalog.workspace!.scenes)[0].scene;
    const reordered = Object.fromEntries(Object.entries(scene).reverse()) as typeof scene;

    expect(stableStringify(reordered)).toBe(stableStringify(scene));
    expect(await sceneHash(reordered)).toBe(await sceneHash(scene));
  });

  it("matches the Mac bridge canonical JSON hash contract", async () => {
    const fixture = {
      id: "scene.test",
      node_order: ["a", "b"],
      nodes: { a: { line: "안녕" }, b: { locked: true } },
    };
    expect(await sha256(stableStringify(fixture))).toBe("14b38d06fa4be07a96d216959e360fa7e1f05cd4aac68cd21961fa2e85f45f3b");
  });
});
