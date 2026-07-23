import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tools/**/*.test.ts"],
    // Type errors are part of the spec here — fail the run on them, not just tsc.
    typecheck: {
      enabled: true,
    },
  },
});
