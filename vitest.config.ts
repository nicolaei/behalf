import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@behalf-js/core/internal": fileURLToPath(
        new URL("./packages/core/src/internal.ts", import.meta.url),
      ),
      "@behalf-js/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts", "docs/examples/**/*.test.ts"],
    // Type errors are part of the spec here — fail the run on them, not just tsc.
    typecheck: {
      enabled: true,
    },
  },
});
