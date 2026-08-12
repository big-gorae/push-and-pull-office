import { describe, expect, it } from "vitest";
import { bundledCatalog, sha256 } from "./sync";

describe("mobile authoring catalog", () => {
  it("creates a path-free, content-addressed catalog", async () => {
    const catalog = await bundledCatalog();

    expect(catalog.entries.length).toBeGreaterThan(500);
    expect(catalog.generation).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(catalog)).not.toMatch(/(?:\/Users\/|story\/scenes\/|\.ya?ml)/);
    expect(catalog.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.valueHash))).toBe(true);
  });

  it("keeps linked perceived/reality fields symmetric", async () => {
    const catalog = await bundledCatalog();
    const entries = new Map(catalog.entries.map((entry) => [entry.localizationKey, entry]));
    const linked = catalog.entries.filter((entry) => entry.linkedLocalizationKeys?.length);

    expect(linked.length).toBeGreaterThan(0);
    for (const entry of linked) {
      for (const key of entry.linkedLocalizationKeys || []) {
        expect(entries.get(key)?.linkedLocalizationKeys).toContain(entry.localizationKey);
        expect(entries.get(key)?.value).toBe(entry.value);
      }
    }
  });

  it("uses deterministic SHA-256 hashes", async () => {
    expect(await sha256("밀당 오피스")).toBe("c3b865a723234bc3b138afe48c1d431154acc0fed6de78cc14085695e210793e");
  });
});
