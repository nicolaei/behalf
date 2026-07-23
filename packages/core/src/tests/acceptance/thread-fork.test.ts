import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

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
    start.then(forked, { threadAction: "fork" });
    forked.then(flow.finish);
  });

  it("runs the target on a new thread id, sharing history up to the split point", async () => {
    const result = (await runFlow(forkGraph, userText("go"), await storeOnlyRuntime())) as {
      startThreadId: unknown;
      forkedThreadId: unknown;
      forkedFrom?: { thread: unknown; at: number };
    };

    expect(result.forkedThreadId).not.toBe(result.startThreadId);
    expect(result.forkedFrom?.thread).toBe(result.startThreadId);
    expect(typeof result.forkedFrom?.at).toBe("number");
  });
});
