import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type PreviewEntry = {
  value?: string;
  pending: Promise<string>;
};

const previewCache = new Map<string, PreviewEntry>();
export const ASSET_PREVIEW_CACHE_LIMIT = 32;

function cacheKey(root: string, relativePath: string): string {
  return `${root}\u0000${relativePath}`;
}

export type AssetPreviewLoader = (root: string, relativePath: string) => Promise<string>;

const defaultLoader: AssetPreviewLoader = (root, relativePath) =>
  invoke<string>("read_asset", { root, relativePath });

export function loadAssetPreview(
  root: string,
  relativePath: string,
  loader: AssetPreviewLoader = defaultLoader,
): Promise<string> {
  const key = cacheKey(root, relativePath);
  const cached = previewCache.get(key);
  if (cached) {
    previewCache.delete(key);
    previewCache.set(key, cached);
    return cached.pending;
  }

  while (previewCache.size >= ASSET_PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    previewCache.delete(oldest);
  }

  const entry: PreviewEntry = {
    pending: loader(root, relativePath).then((value) => {
      entry.value = value;
      return value;
    }).catch((error) => {
      previewCache.delete(key);
      throw error;
    }),
  };
  previewCache.set(key, entry);
  return entry.pending;
}

export function cachedAssetPreview(root: string, relativePath: string): string {
  return previewCache.get(cacheKey(root, relativePath))?.value || "";
}

export function clearAssetPreviewCache(): void {
  previewCache.clear();
}

export function useAssetPreview(root: string, relativePath?: string): string {
  const [source, setSource] = useState(() => relativePath ? cachedAssetPreview(root, relativePath) : "");

  useEffect(() => {
    let active = true;
    if (!relativePath) {
      setSource("");
      return () => { active = false; };
    }
    const cached = cachedAssetPreview(root, relativePath);
    setSource(cached);
    void loadAssetPreview(root, relativePath)
      .then((value) => { if (active) setSource(value); })
      .catch(() => { if (active) setSource(""); });
    return () => { active = false; };
  }, [relativePath, root]);

  return source;
}
