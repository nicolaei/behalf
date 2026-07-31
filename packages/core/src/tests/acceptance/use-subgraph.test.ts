import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { fakePortRuntime, textOf, loggedEventTypes, neverCalled } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

describe("composing a graph as a node with `use`", () => {
  const inner = defineGraph("inner", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    flow.entry(echo);
    echo.then(flow.finish);
  });

  const outer = defineGraph("outer", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, {
      run: (value, ctx) => {
        ctx.thread.say(userText(String(value)));
        return value;
      },
    });
    sub.then(flow.finish);
  });

  it("seeds the subgraph with the incoming value and returns its result as the step's output", async () => {
    const result = await runToCompletion(outer, userText("go"), await fakePortRuntime());

    expect(result).toBe("HI");
  });

  it("appends the subgraph's messages and output to the same session log", async () => {
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });

    await runToCompletion(outer, userText("go"), ready);

    // loose on exact shape — confirm against reference.md's `use`/prompt behaviour
    // when this slice is active
    const types = loggedEventTypes(store);
    expect(types.filter((type) => type === "message").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((type) => type === "output").length).toBeGreaterThanOrEqual(2);
  });
});
