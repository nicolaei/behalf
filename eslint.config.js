import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig([
  { ignores: ["dist/**"] },

  // Type-aware rules — only where a real tsconfig program covers the files.
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
  },

  // Root-level config files: syntax-only, no type program backs them.
  {
    files: ["*.config.js", "*.config.ts", "eslint.config.js"],
    extends: [tseslint.configs.recommended],
  },

  eslintConfigPrettier,
]);
