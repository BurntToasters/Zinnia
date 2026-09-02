import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig(({ mode }) => ({
  root: "src",
  publicDir: "../public",
  define: {
    "import.meta.env.VITE_ZINNIA_E2E": JSON.stringify(
      mode === "e2e" ? "1" : "",
    ),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/index.html"),
        extract: resolve(import.meta.dirname, "src/extract.html"),
        debugConsole: resolve(import.meta.dirname, "src/debug-console.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
}));
