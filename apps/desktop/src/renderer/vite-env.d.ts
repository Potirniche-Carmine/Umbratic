/// <reference types="vite/client" />

import type { DesktopApi } from "../shared/desktopApi";
import type { PreviewEnvironment } from "./previewEnvironment";

declare global {
  const __UMBRATIC_PREVIEW_BUILD__: boolean;

  interface Window {
    __UMBRATIC_PREVIEW__?: boolean;
    __UMBRATIC_PREVIEW_ENVIRONMENT__?: PreviewEnvironment;
    umbratic?: DesktopApi;
    queryLocalFonts?: () => Promise<Array<{ family?: string; fullName?: string }>>;
  }
}

export {};
