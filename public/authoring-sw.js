const CACHE_VERSION = "love-office-authoring-v3";
const APP_SHELL = [
  "/author/",
  "/authoring.webmanifest",
  "/icons/authoring-192.png",
  "/icons/authoring-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("love-office-authoring-") && key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_ASSETS" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls
    .slice(0, 100)
    .filter((value) => {
      try {
        const url = new URL(value, self.location.origin);
        return url.origin === self.location.origin && !url.pathname.startsWith("/api/");
      } catch {
        return false;
      }
    });
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => Promise.allSettled(urls.map((url) => cache.add(url)))));
});

async function navigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("/author/", response.clone());
    return response;
  } catch {
    return (await cache.match("/author/", { ignoreVary: true })) || Response.error();
  }
}

async function staticAsset(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request, { ignoreVary: true });
  const refreshed = fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone());
    return response;
  }).catch(() => undefined);
  return cached || (await refreshed) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigation(event.request));
    return;
  }
  if (["script", "style", "font", "image", "manifest"].includes(event.request.destination)) {
    event.respondWith(staticAsset(event.request));
  }
});
