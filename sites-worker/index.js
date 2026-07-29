const HTML_FALLBACK_PATH = "/index.html";

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== "GET") return response;

    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (!acceptsHtml) return response;

    const fallbackUrl = new URL(HTML_FALLBACK_PATH, request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  },
};

