import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_PREVIEW_CACHE_LIMIT, cachedAssetPreview, clearAssetPreviewCache, loadAssetPreview } from "../assetPreview";

describe("asset preview cache", () => {
  beforeEach(() => clearAssetPreviewCache());

  it("shares one IPC read across duplicate thumbnails", async () => {
    const loader = vi.fn(async () => "data:image/png;base64,preview");
    const [left, right] = await Promise.all([
      loadAssetPreview("/project", "assets/shared.png", loader),
      loadAssetPreview("/project", "assets/shared.png", loader),
    ]);
    expect(left).toBe(right);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cachedAssetPreview("/project", "assets/shared.png")).toBe(left);
  });

  it("evicts failed reads so a later retry can succeed", async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("recovered");
    await expect(loadAssetPreview("/project", "assets/retry.png", loader)).rejects.toThrow("temporary failure");
    await expect(loadAssetPreview("/project", "assets/retry.png", loader)).resolves.toBe("recovered");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("bounds decoded image memory with an LRU cache", async () => {
    const loader = vi.fn(async (_root: string, path: string) => `preview:${path}`);
    for (let index = 0; index <= ASSET_PREVIEW_CACHE_LIMIT; index += 1) {
      await loadAssetPreview("/project", `assets/${index}.png`, loader);
    }
    expect(cachedAssetPreview("/project", "assets/0.png")).toBe("");
    await loadAssetPreview("/project", "assets/0.png", loader);
    expect(loader).toHaveBeenCalledTimes(ASSET_PREVIEW_CACHE_LIMIT + 2);
  });
});
