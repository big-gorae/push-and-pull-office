import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

const WebGame = lazy(() => import("./player/WebGame"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "linear-gradient(145deg, #fff7fb, #fffbea)" }} />}>
      <WebGame />
    </Suspense>
  </StrictMode>,
);
