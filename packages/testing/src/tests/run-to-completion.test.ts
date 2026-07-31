import { describe, it, expect } from "vitest";
import { runToCompletion } from "../index.js";
import { defineGraph, runtime, outputs, seed } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";

// `runToCompletion` is the test-suite counterpart to a production `seed()` +
// `driveFlow()` pair: it drives a flow from wherever its log already stands to
// the root cursor's result. The "seed if empty" branch is the interesting
// half — an already-started session must be resumed, never re-seeded, or the
// replay would see two starting events and lose the caller's real input.

const echo = defineGraph("run-to-completion-echo", (flowBuilder) => {
  const step = flowBuilder.step(outputs((context) => `echo:${String(context.inputs[0])}`));
  flowBuilder.entry(step);
  step.then(flowBuilder.finish);
});

describe("runToCompletion", () => {
  it("seeds an empty session and drives it to the root result", async () => {
    const ready = await runtime({ store: memoryStore() });

    const result = await runToCompletion(echo, "hello", ready);

    expect(result).toBe("echo:hello");
    const inputs = ready.store.events().filter((envelope) => envelope.type === "input");
    expect(inputs).toHaveLength(1);
  });

  it("resumes an already-seeded session without re-seeding it", async () => {
    const ready = await runtime({ store: memoryStore() });
    seed(echo, "original", ready);

    const result = await runToCompletion(echo, "ignored", ready);

    expect(result).toBe("echo:original");
    const inputs = ready.store.events().filter((envelope) => envelope.type === "input");
    expect(inputs).toHaveLength(1);
  });
});
