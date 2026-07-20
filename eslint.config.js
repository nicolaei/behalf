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

  // Acceptance tests are black-box against the public surface.
  // They may only import from ../../index.js (public API) or ../../testing
  // (future public test helpers). Internal engine/flow/adapter/session/gateway
  // modules are off-limits.
  {
    files: ["src/tests/acceptance/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../../engine/*",
                "../../flow/*",
                "../../adapters/**",
                "../../session/*",
                "../../gateway/*",
              ],
              message:
                "Acceptance tests are black-box — import from ../../index.js or ../../testing (both public), not internal modules directly.",
            },
          ],
        },
      ],
    },
  },

  // src/engine/runtime/ sub-modules (fan-out.ts, drive.ts, execution.ts, ids.ts,
  // routing.ts, step-runner.ts, tick.ts) are necessarily exported so they can
  // import each other, but that also makes them reachable directly from
  // anywhere else in the codebase, bypassing the engine/runtime.js barrel.
  // This rule blocks that: only files inside src/engine/runtime/ itself, or
  // src/engine/runtime.ts (the barrel), may import a sub-module directly.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/engine/runtime/**", "src/engine/runtime.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/runtime/*"],
              message:
                "Import from engine/runtime.js (the barrel), not its internal sub-modules directly.",
            },
          ],
        },
      ],
    },
  },

  eslintConfigPrettier,
]);
