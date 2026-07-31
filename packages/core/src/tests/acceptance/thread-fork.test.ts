import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, userText, outputs, forkThread } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

describe("forking a thread on an edge", () => {
  const forkGraph = defineGraph("fork-edge", (flow) => {
    const start = flow.step(outputs((context) => context.thread.id));
    const forked = flow.step(
      outputs((context) => ({
        startThreadId: context.inputs[0],
        forkedThreadId: context.thread.id,
        forkedFrom: context.thread.forkedFrom,
      })),
    );
    flow.entry(start);
    start.then(forked, { run: forkThread(() => undefined) });
    forked.then(flow.finish);
  });

  it("runs the target on a new thread id, sharing history up to the split point", async () => {
    const ready = await runtime({
      store: memoryStore(),
      extensions: [ai({ models: neverCalled, bindings: [] })],
    });
    const result = (await runToCompletion(forkGraph, userText("go"), ready)) as {
      startThreadId: unknown;
      forkedThreadId: unknown;
      forkedFrom?: { thread: unknown; at: number };
    };

    expect(result.forkedThreadId).not.toBe(result.startThreadId);
    expect(result.forkedFrom?.thread).toBe(result.startThreadId);
    expect(typeof result.forkedFrom?.at).toBe("number");
  });
});
