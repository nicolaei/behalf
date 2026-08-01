import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig([
  { ignores: ["dist/**", ".worktrees/**"] },

  // Type-aware rules — only where a real tsconfig program covers the files.
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
  },

  // tools/ — repo-internal dev tooling, not part of the published package;
  // see tools/tsconfig.json (its own project, not src/'s).
  {
    files: ["tools/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir,
      },
    },
  },

  // docs/examples/ — typechecked, tested doc snippets; see docs/examples/tsconfig.json
  // (its own project) and docs/style-guide.md's "Example files" section.
  {
    files: ["docs/examples/**/*.ts"],
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
  // (future public test helpers). Internal ai/adapter modules are off-limits,
  // and so is reaching past `@behalf-js/core` into `@behalf-js/engine`.
  {
    files: ["packages/core/src/tests/acceptance/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../../ai/*",
                "../../adapters/**",
                "@behalf-js/engine",
                "@behalf-js/engine/*",
              ],
              message:
                "Acceptance tests are black-box — import from ../../index.js or ../../testing (both public), not internal modules or @behalf-js/engine directly.",
            },
          ],
        },
      ],
    },
  },

  // Layering: graph ← session ← {gateway, runtime} ← ai (see
  // .plans/restructure-cockpit-and-behalf.md, "Refactoring Behalf" §
  // "Core folders and their interface"). B3.1 made the top edge of that
  // stack physical: graph/session/gateway/runtime now live in
  // `@behalf-js/engine`, which does not depend on `@behalf-js/core` at all,
  // so an engine → ai import fails to resolve rather than merely failing
  // lint. This rule stays as the early, legible signal — and as the guard
  // against the one import that WOULD resolve, `@behalf-js/core` itself
  // (npm hoists it into node_modules for the other workspace packages).
  //
  // Split by directory rather than by rule: flat config replaces a rule's
  // whole setting per matching block instead of merging pattern arrays across
  // blocks, so two blocks matching the same file would silently drop one
  // another's patterns. runtime/ gets the ai ban only (its sub-modules import
  // each other by design); everything else gets the ai ban plus the barrel
  // lockdown.
  {
    files: ["packages/engine/src/runtime/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@behalf-js/core", "@behalf-js/core/*", "**/ai/*"],
              message:
                "The engine must not import ai — @behalf-js/core is the top layer and depends on the engine, never the reverse. Whatever the engine needs from an extension arrives through the EngineExtension seam (runtime/extension.ts).",
            },
          ],
        },
      ],
    },
  },

  // Everything in the engine outside runtime/ (graph/, session/, gateway/, the
  // barrels, tests) — same ai ban, plus the runtime sub-module lockdown: those
  // files are exported so they can import each other, which also makes them
  // reachable directly, bypassing runtime/index.js.
  {
    files: ["packages/engine/src/**/*.ts"],
    ignores: ["packages/engine/src/runtime/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@behalf-js/core", "@behalf-js/core/*", "**/ai/*"],
              message:
                "The engine must not import ai — @behalf-js/core is the top layer and depends on the engine, never the reverse. Whatever the engine needs from an extension arrives through the EngineExtension seam (runtime/extension.ts).",
            },
            {
              group: [
                "**/runtime/tick.js",
                "**/runtime/drive.js",
                "**/runtime/step-runner.js",
                "**/runtime/routing.js",
                "**/runtime/fan-out.js",
                "**/runtime/foreach.js",
                "**/runtime/ids.js",
                "**/runtime/execution.js",
              ],
              message:
                "Import from runtime/index.js (the barrel), not its internal sub-modules directly.",
            },
          ],
        },
      ],
    },
  },

  // ai/ sits ON TOP of the engine and must reach it only through the package's
  // public surface. The B3.1 extraction narrowed the runtime-submodule lockdown
  // from `packages/core/src/**` to `packages/engine/src/**`, which silently left
  // `core/src/ai/**` unguarded (acceptance tests kept their own block, ai/ did
  // not). Restored here: whatever ai needs from the engine arrives via
  // `@behalf-js/engine`, not by reaching into its internals.
  {
    files: ["packages/core/src/ai/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/runtime/tick.js",
                "**/runtime/drive.js",
                "**/runtime/step-runner.js",
                "**/runtime/routing.js",
                "**/runtime/fan-out.js",
                "**/runtime/foreach.js",
                "**/runtime/ids.js",
                "**/runtime/execution.js",
                "**/runtime/extension.js",
                "**/runtime/coverage.js",
                "@behalf-js/engine/dist/**",
              ],
              message:
                "Import from @behalf-js/engine (the public surface), not the engine's internal sub-modules.",
            },
          ],
        },
      ],
    },
  },

  // @behalf-js/testing's own layering, mirroring core's: the root subpath is
  // the pure engine stepping vocabulary and must never reach into ai/ — a
  // test helper that needs a model fake belongs on the ./ai subpath. ai/ and
  // eval/ are exempt (eval sits atop ai by design).
  {
    files: ["packages/testing/src/**/*.ts"],
    ignores: [
      "packages/testing/src/ai/**",
      "packages/testing/src/eval/**",
      "packages/testing/src/tests/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./ai/*", "../ai/*", "**/testing/src/ai/*", "@behalf-js/testing/ai"],
              message:
                "@behalf-js/testing's root subpath must not import from ai/ — the stepping vocabulary is engine-only. A helper that needs a model fake belongs under src/ai/ and ships on the ./ai subpath.",
            },
          ],
        },
      ],
    },
  },

  eslintConfigPrettier,
]);
