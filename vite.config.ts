import { defineConfig, type Plugin } from "vite";
import { sites } from "./build/sites-vite-plugin";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";
const APP_BUILD_ID = (
  process.env.GITHUB_SHA
  || process.env.SITES_COMMIT_SHA
  || process.env.VITE_APP_BUILD_ID
  || new Date().toISOString().replace(/\D/g, "").slice(0, 14)
).slice(0, 40);
const APP_BUILD_TIME = process.env.VITE_APP_BUILD_TIME || new Date().toISOString();

function appVersionPlugin(): Plugin {
  const developmentBody = `${JSON.stringify({ buildId: APP_BUILD_ID, builtAt: APP_BUILD_TIME, assets: [] })}\n`;
  return {
    name: "love-office-app-version",
    configureServer(server) {
      server.middlewares.use("/app-version.json", (_request, response) => {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store, max-age=0");
        response.end(developmentBody);
      });
    },
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .filter((fileName) => /\.(?:css|js)$/.test(fileName))
        .map((fileName) => `/${fileName}`)
        .sort();
      const source = `${JSON.stringify({ buildId: APP_BUILD_ID, builtAt: APP_BUILD_TIME, assets })}\n`;
      this.emitFile({ type: "asset", fileName: "app-version.json", source });
    },
  };
}

export default defineConfig(async () => {
  const isGameBuild = process.env.VITE_APP_SURFACE === "game";
  const isGitHubPagesBuild = process.env.VITE_HOSTING_TARGET === "github-pages";
  const isSiteBuild = isGameBuild && !isGitHubPagesBuild;
  const plugins: Plugin[] = [appVersionPlugin()];

  if (isSiteBuild) {
    process.env.WRANGLER_WRITE_LOGS ??= "false";
    process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
    process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

    const { cloudflare } = await import("@cloudflare/vite-plugin");
    plugins.push(
      sites(),
      cloudflare({
        viteEnvironment: { name: "server" },
        config: {
          main: "./sites-worker/index.js",
          compatibility_date: "2026-05-15",
          compatibility_flags: ["nodejs_compat"],
          assets: {
            binding: "ASSETS",
            not_found_handling: "single-page-application",
          },
          d1_databases: hostingConfig.d1 ? [{
            binding: hostingConfig.d1,
            database_name: "love-office-authoring",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          }] : [],
        },
      }),
    );
  }

  return {
    base: isGitHubPagesBuild
      ? (process.env.VITE_BASE_PATH ?? "/push-and-pull-office/")
      : "/",
    clearScreen: false,
    plugins,
    define: {
      __LOVE_OFFICE_BUILD_ID__: JSON.stringify(APP_BUILD_ID),
      __LOVE_OFFICE_BUILD_TIME__: JSON.stringify(APP_BUILD_TIME),
    },
    server: {
      strictPort: true,
      port: 1420,
      watch: {
        // Authoring saves rebuild this imported snapshot. The player applies
        // edited strings from the save response itself, so treating the JSON
        // write as HMR would discard the live session and return to the title.
        ignored: ["**/build/story-runtime.json"],
      },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
      minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    },
  };
});
