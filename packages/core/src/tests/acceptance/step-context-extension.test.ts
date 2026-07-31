import { describe, it, expect } from "vitest";
import { defineGraph, runtime, runFlow, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { EngineExtension } from "../../index.js";
import { neverCalled } from "./support.js";

// Test-only extension — not shipped. Proves `EngineExtension.stepContext` gets merged into
// every `StepContext` the runtime builds, alongside the built-in fields (inputs, thread,
// openStream, appendEvent, …). A dummy `debugLabel()` method stands in for a real
// extension's contribution (e.g. ai's future `modelCall`/`thread`).
describe("EngineExtension.stepContext merges a contributed method into StepContext", () => {
  it("a step can call the contributed debugLabel()", async () => {
    const extension: EngineExtension = {
      name: "test-debug-ext",
      stepContext() {
        return { debugLabel: () => "debug-label-value" };
      },
    };

    const flow = defineGraph("step-context-extension", (flowBuilder) => {
      const step = flowBuilder.step(
        outputs((context) => (context as unknown as { debugLabel(): string }).debugLabel()),
      );
      flowBuilder.entry(step);
      step.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store,
      extensions: [extension],
    });

    const result = await runFlow(flow, userText("go"), ready);

    expect(result).toBe("debug-label-value");
  });
});
