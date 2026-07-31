import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs, startThread } from "../../index.js";
import { fakePortRuntime } from "./support.js";

describe("a `use` node reached via ctx.thread.start on the reaching edge", () => {
  const inner = defineGraph("inner-fresh", (flow) => {
    const echo = flow.step(outputs((context) => context.thread.messages.length));
    flow.entry(echo);
    echo.then(flow.finish);
  });

  const outer = defineGraph("outer-fresh", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, { run: startThread((value) => userText(String(value))) });
    sub.then(flow.finish);
  });

  it("starts the subgraph on a brand-new thread when the reaching edge says so", async () => {
    const result = await runFlow(outer, userText("go"), await fakePortRuntime());

    expect(result).toBe(1);
  });
});
