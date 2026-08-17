import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  plugins: [react()],
  root: "src/renderer",
  base: "./",
  define: {
    __UMBRATIC_PREVIEW_BUILD__: JSON.stringify(command === "serve"),
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    // The audio worklet has to stay a real same-origin file. It is small enough
    // that Vite would otherwise inline it as a `data:` URL, and the renderer's
    // CSP is `script-src 'self'` — `audioWorklet.addModule` would be refused at
    // runtime, which is a failure no build step would have caught.
    assetsInlineLimit: (filePath: string) =>
      filePath.endsWith(".worklet.js") ? false : undefined,
  },
}));
