import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        extract: resolve(__dirname, "src/extract.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    clearScreen: false,
  },
});
