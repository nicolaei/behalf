import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("starting a brand-new thread on an edge", () => {
  const newThreadGraph = defineGraph("new-thread-edge", (flow) => {
    const start = flow.step(outputs(() => "go"));
    const onNewThread = flow.step(outputs((context) => context.thread.messages.length));
    flow.entry(start);
    start.then(onNewThread, { threadAction: "new", prompt: () => userText("fresh start") });
    onNewThread.then(flow.finish);
  });

  it("starts the target with only its own seeded prompt, none of the prior thread", async () => {
    const result = await runFlow(newThreadGraph, userText("go"), await storeOnlyRuntime());

    expect(result).toBe(1);
  });
});
