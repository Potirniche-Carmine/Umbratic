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
  },
}));

