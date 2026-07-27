import { createPreviewEnvironment } from "./previewEnvironment";

window.__UMBRATIC_PREVIEW__ = true;
window.__UMBRATIC_PREVIEW_ENVIRONMENT__ = createPreviewEnvironment();
await import("./main");

export {};
