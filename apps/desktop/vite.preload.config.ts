import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: fileURLToPath(new URL("./src/preload/preload.ts", import.meta.url)),
      fileName: () => "preload/preload.js",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "dist-electron",
    rollupOptions: {
      external: ["electron"],
      output: {
        exports: "named",
      },
    },
  },
});
