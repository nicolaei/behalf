import { describe, it, expect } from "vitest";
import {
  defineGraph,
  tickUntilSuspended,
  runtime,
  userText,
  adapters,
  outputs,
} from "../../index.js";
import { neverCalled, textOf, loggedEventTypes } from "./support.js";

// Needs tick() to support "use" nodes — currently it throws
// notImplemented("tick: node kind \"use\"") whenever the replayed position
// lands on one. Mirrors use-subgraph.test.ts's graph shape, driven via
// tick() instead of runFlow.
describe("ticking a flow through a used subgraph", () => {
  const inner = defineGraph("tick-use-inner", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    flow.entry(echo);
    echo.then(flow.finish);
  });

  const outer = defineGraph("tick-use-outer", (flow) => {
    const start = flow.step(outputs(() => "hi"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, { prompt: (value) => userText(String(value)) });
    sub.then(flow.finish);
  });

  it("advances through the used subgraph and returns its result via tickUntilSuspended", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const outcome = await tickUntilSuspended(outer, ready);

    expect(outcome).toEqual({ status: "done", result: "HI" });
  });

  it("appends the subgraph's messages and output to the same session log", async () => {
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await tickUntilSuspended(outer, ready);

    // loose on exact shape. Only 1 message is possible here (not 2, unlike
    // use-subgraph.test.ts's runFlow-driven version): tick() has no initial-
    // prompt argument of its own — the only message this graph ever produces
    // is the edge-computed prompt into the use node, logged once by driveUseNode.
    const types = loggedEventTypes(store);
    expect(types.filter((type) => type === "message").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((type) => type === "output").length).toBeGreaterThanOrEqual(2);
  });
});
