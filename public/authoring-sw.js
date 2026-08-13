const BUILD_ID = new URL(self.location.href).searchParams.get("v") || "legacy";
const SHELL_PREFIX = "love-office-authoring-shell-";
const SHELL_CACHE = `${SHELL_PREFIX}${BUILD_ID}`;
const ASSET_CACHE = "love-office-authoring-assets-v1";
const LEGACY_PREFIX = "love-office-authoring-";
const APP_SHELL = [
  "/",
  "/authoring.webmanifest",
  "/icons/authoring-192.png",
  "/icons/authoring-512.png",
];

function sameOriginUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url : undefined;
  } catch {
    return undefined;
  }
}

function isPersistentAsset(value) {
  const url = sameOriginUrl(value);
  return Boolean(url?.pathname.startsWith("/assets/")
    && /\.(?:avif|gif|jpe?g|png|svg|webp|woff2?|ttf|otf|mp3|ogg|wav|m4a|mp4|webm)$/i.test(url.pathname));
}

async function cacheFreshShell() {
  const cache = await caches.open(SHELL_CACHE);
  const paths = [...APP_SHELL];
  const markerResponse = await fetch(`/app-version.json?install=${encodeURIComponent(BUILD_ID)}`, { cache: "reload" });
  if (!markerResponse.ok) throw new Error(`VERSION_MARKER_${markerResponse.status}`);
  const marker = await markerResponse.json();
  if (marker?.buildId !== BUILD_ID || !Array.isArray(marker.assets)) throw new Error("VERSION_MARKER_INVALID");
  paths.push(...marker.assets.filter((value) => typeof value === "string" && sameOriginUrl(value) && !isPersistentAsset(value)));
  await Promise.all([...new Set(paths)].map(async (path) => {
    const response = await fetch(path, { cache: "reload" });
    if (!response.ok) throw new Error(`SHELL_ASSET_${response.status}`);
    await cache.put(path, response);
  }));
}

async function migrateAssets(cacheName) {
  const source = await caches.open(cacheName);
  const target = await caches.open(ASSET_CACHE);
  await Promise.allSettled((await source.keys()).filter((request) => isPersistentAsset(request.url)).map(async (request) => {
    if (await target.match(request)) return;
    const response = await source.match(request);
    if (response) await target.put(request, response);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheFreshShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const obsolete = names.filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE
      && (name.startsWith(SHELL_PREFIX) || name.startsWith(LEGACY_PREFIX)));
    await Promise.allSettled(obsolete.map(migrateAssets));
    await Promise.all(obsolete.map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type !== "CACHE_ASSETS" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.slice(0, 100).map(sameOriginUrl).filter(Boolean);
  event.waitUntil((async () => {
    const [assetCache, shellCache] = await Promise.all([caches.open(ASSET_CACHE), caches.open(SHELL_CACHE)]);
    await Promise.allSettled(urls.map(async (url) => {
      const cache = isPersistentAsset(url.href) ? assetCache : shellCache;
      if (await cache.match(url.href)) return;
      const response = await fetch(url.href);
      if (response.ok) await cache.put(url.href, response);
    }));
  })());
});

async function navigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put("/", response.clone());
    return response;
  } catch {
    return (await cache.match("/", { ignoreVary: true })) || Response.error();
  }
}

async function immutableAsset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return Response.error();
  }
}

async function currentStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreVary: true })) || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigation(event.request));
    return;
  }
  if (isPersistentAsset(url.href)) {
    event.respondWith(immutableAsset(event.request));
    return;
  }
  if (["script", "style", "font", "image", "manifest"].includes(event.request.destination)) {
    event.respondWith(currentStatic(event.request));
  }
});
