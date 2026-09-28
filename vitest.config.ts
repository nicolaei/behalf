import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "tools/**/*.test.ts", "docs/examples/**/*.test.ts"],
    maxConcurrency: 30,
    // A wedged engine loop is pure microtasks and can starve the event loop, so
    // a generous per-test timeout is the only thing that turns a hang into a
    // reportable failure.
    testTimeout: 10_000,
    // Type errors are part of the spec here — fail the run on them, not just tsc.
    typecheck: {
      enabled: true,
    },
  },
});
