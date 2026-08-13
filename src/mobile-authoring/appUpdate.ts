export const CURRENT_BUILD_ID = __LOVE_OFFICE_BUILD_ID__;

type FetchVersion = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function validBuildId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{6,40}$/.test(value);
}

export async function fetchLatestBuildId(
  fetchVersion: FetchVersion = window.fetch.bind(window),
  cacheToken = Date.now(),
): Promise<string> {
  const response = await fetchVersion(`/app-version.json?check=${encodeURIComponent(cacheToken)}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "cache-control": "no-cache" },
  });
  if (!response.ok) throw new Error(`VERSION_CHECK_${response.status}`);
  const body = await response.json() as { buildId?: unknown };
  if (!validBuildId(body.buildId)) throw new Error("VERSION_CHECK_INVALID");
  return body.buildId;
}

export function reloadUrlForBuild(currentUrl: string, buildId: string): string {
  if (!validBuildId(buildId)) throw new Error("VERSION_INVALID");
  const url = new URL(currentUrl);
  url.searchParams.set("app-version", buildId);
  return url.toString();
}

function activated(registration: ServiceWorkerRegistration, buildId: string): boolean {
  return Boolean(registration.active?.scriptURL.includes(`v=${encodeURIComponent(buildId)}`));
}

export async function installBuildWorker(
  buildId: string,
  serviceWorker: ServiceWorkerContainer = navigator.serviceWorker,
): Promise<void> {
  if (!validBuildId(buildId)) throw new Error("VERSION_INVALID");
  const registration = await serviceWorker.register(`/authoring-sw.js?v=${encodeURIComponent(buildId)}`, {
    scope: "/",
    updateViaCache: "none",
  });
  if (activated(registration, buildId)) return;

  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  registration.installing?.postMessage({ type: "SKIP_WAITING" });
  await Promise.race([
    new Promise<void>((resolve) => serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })),
    new Promise<void>((resolve) => window.setTimeout(resolve, 3_000)),
  ]);
}

export function shortBuildId(buildId = CURRENT_BUILD_ID): string {
  return buildId.length > 12 ? buildId.slice(0, 12) : buildId;
}
