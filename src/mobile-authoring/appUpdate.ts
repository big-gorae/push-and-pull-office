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

export function reloadUrlForBuild(currentUrl: string, buildId: string, cacheToken?: number): string {
  if (!validBuildId(buildId)) throw new Error("VERSION_INVALID");
  const url = new URL(currentUrl);
  url.searchParams.set("app-version", buildId);
  if (cacheToken !== undefined) url.searchParams.set("app-reload", String(cacheToken));
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

  const pendingWorker = registration.waiting || registration.installing;
  if (!pendingWorker && registration.active) return;

  pendingWorker?.postMessage({ type: "SKIP_WAITING" });
  await Promise.race([
    new Promise<void>((resolve) => serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })),
    new Promise<void>((resolve) => window.setTimeout(resolve, 5_000)),
  ]);
}

export async function refreshBuildShell(
  buildId: string,
  serviceWorker: ServiceWorkerContainer = navigator.serviceWorker,
): Promise<void> {
  await installBuildWorker(buildId, serviceWorker);
  const registration = await serviceWorker.ready;
  const worker = serviceWorker.controller || registration.active;
  if (!worker) throw new Error("APP_REFRESH_WORKER_MISSING");

  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      channel.port1.close();
      if (error) reject(error);
      else resolve();
    };
    const timeout = window.setTimeout(() => finish(new Error("APP_REFRESH_TIMEOUT")), 10_000);
    channel.port1.onmessage = (event: MessageEvent<{ ok?: boolean; buildId?: string }>) => {
      if (event.data?.ok && event.data.buildId === buildId) finish();
      else finish(new Error("APP_REFRESH_FAILED"));
    };
    worker.postMessage({ type: "REFRESH_SHELL", buildId }, [channel.port2]);
  });
}

export function shortBuildId(buildId = CURRENT_BUILD_ID): string {
  return buildId.length > 12 ? buildId.slice(0, 12) : buildId;
}
