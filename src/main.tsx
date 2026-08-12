import { lazy, StrictMode, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const PromptBuilder = lazy(() => import("./prompt-builder/PromptBuilder"));
const MobileAuthoringApp = lazy(() => import("./mobile-authoring/MobileAuthoringApp"));
const WebGame = lazy(() => import("./player/WebGame"));
const EditorApp = lazy(async () => {
  await import("./styles.css");
  return import("./App");
});

function SurfaceRouter() {
  const [, refreshLocation] = useState(0);
  useEffect(() => {
    const refresh = () => refreshLocation((value) => value + 1);
    window.addEventListener("hashchange", refresh);
    window.addEventListener("popstate", refresh);
    return () => {
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("popstate", refresh);
    };
  }, []);

  const isPromptBuilder = window.location.pathname.startsWith("/prompts")
    || window.location.hash.startsWith("#/prompts");
  const isMobileAuthoring = window.location.pathname.startsWith("/author")
    || window.location.hash.startsWith("#/author");
  const isEditorRoute = window.location.pathname.startsWith("/editor")
    || window.location.hash.startsWith("#/editor");
  const isWebGame = !isPromptBuilder && !isEditorRoute && (import.meta.env.VITE_APP_SURFACE === "game"
    || window.location.pathname.startsWith("/play")
    || window.location.hash.startsWith("#/play"));

  return isMobileAuthoring
    ? <MobileAuthoringApp />
    : isPromptBuilder
      ? <PromptBuilder />
      : isWebGame
        ? <WebGame />
        : <EditorApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "linear-gradient(145deg, #fff7fb, #fffbea)" }} />}>
      <SurfaceRouter />
    </Suspense>
  </StrictMode>,
);
