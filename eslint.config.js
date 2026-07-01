// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/vendor/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Plain-ESM Node scripts (plugin hooks + bundle): run under `node` with no build step,
    // so they need Node's runtime globals (process, Buffer, console, URL, …).
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        URL: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
  },
);
