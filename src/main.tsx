import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

const isWebGame = import.meta.env.VITE_APP_SURFACE === "game"
  || window.location.pathname.startsWith("/play")
  || window.location.hash.startsWith("#/play");
const WebGame = lazy(() => import("./player/WebGame"));
const EditorApp = lazy(async () => {
  await import("./styles.css");
  return import("./App");
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "linear-gradient(145deg, #fff7fb, #fffbea)" }} />}>
      {isWebGame ? <WebGame /> : <EditorApp />}
    </Suspense>
  </StrictMode>,
);
