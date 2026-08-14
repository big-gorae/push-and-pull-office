import { describe, expect, it, vi } from "vitest";
import { fetchLatestBuildId, reloadUrlForBuild, shortBuildId } from "./appUpdate";

describe("mobile app updates", () => {
  it("checks the uncached deployment marker", async () => {
    const fetchVersion = vi.fn(async () => new Response(JSON.stringify({ buildId: "build-20260814" }), { status: 200 }));

    await expect(fetchLatestBuildId(fetchVersion, 42)).resolves.toBe("build-20260814");
    expect(fetchVersion).toHaveBeenCalledWith("/app-version.json?check=42", expect.objectContaining({ cache: "no-store" }));
  });

  it("rejects malformed deployment markers", async () => {
    const fetchVersion = vi.fn(async () => new Response(JSON.stringify({ buildId: "<script>" }), { status: 200 }));
    await expect(fetchLatestBuildId(fetchVersion, 42)).rejects.toThrow("VERSION_CHECK_INVALID");
  });

  it("preserves the author route while replacing the cache-busting build", () => {
    expect(reloadUrlForBuild("https://office.example/?app-version=old#/author", "build-20260814"))
      .toBe("https://office.example/?app-version=build-20260814#/author");
  });

  it("adds a unique reload token for a forced refresh", () => {
    expect(reloadUrlForBuild("https://office.example/#/author", "build-20260814", 1234))
      .toBe("https://office.example/?app-version=build-20260814&app-reload=1234#/author");
  });

  it("uses a compact build label", () => {
    expect(shortBuildId("1234567890abcdef")).toBe("1234567890ab");
  });
});
