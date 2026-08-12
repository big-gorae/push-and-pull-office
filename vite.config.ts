import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";
import hostingConfig from "./.openai/hosting.json";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID = "00000000-0000-4000-8000-000000000000";

export default defineConfig(async () => {
  const isGameBuild = process.env.VITE_APP_SURFACE === "game";
  const isGitHubPagesBuild = process.env.VITE_HOSTING_TARGET === "github-pages";
  const isSiteBuild = isGameBuild && !isGitHubPagesBuild;
  const plugins = [];

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
