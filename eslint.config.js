import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import noUnsanitized from "eslint-plugin-no-unsanitized";

// Node-side globals come from the running runtime, so no `globals` package is
// needed. CommonJS wrapper names are listed separately for .cjs files.
const nodeGlobals = Object.fromEntries(
  Object.getOwnPropertyNames(globalThis).map((name) => [name, "readonly"]),
);
const cjsGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  __dirname: "readonly",
  __filename: "readonly",
};

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/tests/**"],
    plugins: {
      "no-unsanitized": noUnsanitized,
    },
    rules: {
      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "warn",
        { assertionStyle: "as" },
      ],
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
  {
    files: [
      "scripts/**/*.{js,mjs,cjs,ts}",
      "bench/**/*.{js,mjs,cjs}",
      "e2e/**/*.js",
    ],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Node-only scripts and bench code. Core rules here are the subset of
    // eslint:recommended that catches real bugs without touching e2e/ or src/.
    // Switch to js.configs.recommended once @eslint/js is a declared devDependency.
    files: ["scripts/**/*.{mjs,cjs}", "bench/**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...nodeGlobals, ...cjsGlobals },
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-dupe-class-members": "error",
      "no-unsafe-finally": "error",
      "no-self-assign": "error",
      "no-redeclare": "error",
      "no-cond-assign": "error",
      // Empty catch blocks are deliberate best-effort cleanup in these scripts.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-useless-escape": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
];
