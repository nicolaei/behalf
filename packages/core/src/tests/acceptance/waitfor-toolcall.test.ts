import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, toolCall } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { WaitForResult } from "../../index.js";
import { neverCalled } from "./support.js";

// toolCall(correlationId)'s match() throws notImplemented — it's still a
// Story 1 stub. Written now, isolated from forEach entirely, so the
// Waitable's own correctness is proven independently: a plain
// waitFor(toolCall(id)), resolved by committing a matching toolResult
// directly (standing in for whatever eventually resolves it — a tool
// executor, in later stories), resumes with the tool's own output.
describe("toolCall(correlationId) Waitable resolves via a committed toolResult", () => {
  const flow = defineGraph("wait-for-tool-call", (flowBuilder) => {
    const wait = flowBuilder.waitFor(toolCall("call-1"));
    const after = flowBuilder.step(outputs((context) => context.inputs[0]));
    flowBuilder.entry(wait);
    wait.then(after);
    after.then(flowBuilder.finish);
  });

  it("resumes with the tool's output once a matching toolResult is committed", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.append({ correlationId: "call-1", output: { celsius: 21 } }, { type: "toolResult" });

    const result = (await done) as WaitForResult<{ celsius: number }>;
    expect(result).toEqual({ ok: true, result: { celsius: 21 } });
  });

  it("ignores a toolResult with a different correlationId", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.append(
      { correlationId: "some-other-call", output: "irrelevant" },
      { type: "toolResult" },
    );
    store.append({ correlationId: "call-1", output: { celsius: 21 } }, { type: "toolResult" });

    const result = (await done) as WaitForResult<{ celsius: number }>;
    expect(result).toEqual({ ok: true, result: { celsius: 21 } });
  });
});
