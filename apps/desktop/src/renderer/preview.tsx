import { createPreviewEnvironment } from "./previewEnvironment";

window.__UMBRATIC_PREVIEW__ = true;
window.__UMBRATIC_PREVIEW_ENVIRONMENT__ = createPreviewEnvironment();
if (new URLSearchParams(window.location.search).get("uiTest") === "activity") await import("./previewActivityUi");
else await import("./main");

export {};
