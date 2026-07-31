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
  // (future public test helpers). Internal graph/ai/session/gateway/runtime/adapter
  // modules are off-limits.
  {
    files: ["packages/core/src/tests/acceptance/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../../graph/*",
                "../../ai/*",
                "../../adapters/**",
                "../../session/*",
                "../../gateway/*",
                "../../runtime/*",
              ],
              message:
                "Acceptance tests are black-box — import from ../../index.js or ../../testing (both public), not internal modules directly.",
            },
          ],
        },
      ],
    },
  },

  // Layering: graph ← session ← {gateway, runtime} ← ai (see
  // .plans/restructure-cockpit-and-behalf.md, "Refactoring Behalf" §
  // "Core folders and their interface"). ai sits on top and may import
  // everything below it; the enforceable, at-risk direction is the reverse —
  // graph/session/gateway/runtime must never import from ai/. Pre-existing
  // violations (graph/{step,graph,waitable}.ts, gateway/gateway.ts,
  // runtime/{drive,tick,execution,…}.ts importing ai-shaped Message/UserMessage
  // types) are exempted line-by-line via eslint-disable-next-line, each
  // tagged with the specific B2 step that removes it — not carved out here,
  // so this rule still catches any NEW lower-layer → ai import.
  //
  // Combined in the SAME block as the runtime submodule barrel-lockdown
  // (below) rather than a separate one: flat config replaces a rule's whole
  // setting per matching block instead of merging pattern arrays across
  // blocks, so a later block matching the same files would silently drop an
  // earlier one's patterns.
  {
    files: [
      "packages/core/src/graph/**/*.ts",
      "packages/core/src/session/**/*.ts",
      "packages/core/src/gateway/**/*.ts",
      "packages/core/src/runtime/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../ai/*"],
              message:
                "graph/session/gateway/runtime must not import from ai/ — ai is the top layer and depends on them, never the reverse. A pre-existing violation here needs an eslint-disable-next-line with a TODO(B2 step N) comment, not a rule exception.",
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

  // src/runtime/ sub-modules (tick.ts, drive.ts, step-runner.ts, routing.ts,
  // fan-out.ts, foreach.ts, ids.ts, execution.ts) are necessarily exported so
  // they can import each other, but that also makes them reachable directly
  // from anywhere else in the codebase, bypassing the runtime/index.js
  // barrel. This rule blocks that for every OTHER file in the package (ai/,
  // the top-level index.ts/internal.ts, tests/) — graph/session/gateway/
  // runtime themselves are covered by the combined block above instead, to
  // avoid two blocks setting the same rule for the same files.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: [
      "packages/core/src/runtime/**",
      "packages/core/src/graph/**",
      "packages/core/src/session/**",
      "packages/core/src/gateway/**",
    ],
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
              ],
              message:
                "Import from runtime/index.js (the barrel), not its internal sub-modules directly.",
            },
          ],
        },
      ],
    },
  },

  eslintConfigPrettier,
]);
