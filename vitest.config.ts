import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/tests/**/*.test.ts"],
    setupFiles: ["src/tests/setup-dom.ts"],
    restoreMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**", "src/vite-env.d.ts"],
      thresholds: {
        lines: 79.5,
        functions: 76,
        branches: 63,
        statements: 77.5,
      },
    },
  },
});
