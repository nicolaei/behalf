import { describe, it, expect } from "vitest";
import { tick, tickUntilSuspended } from "../../engine/runtime.js";
import type { TickOutcome } from "../../engine/runtime.js";
import { defineGraph, runtime, userText, adapters, join, outputs } from "../../index.js";
import { neverCalled } from "../acceptance/support.js";

// Needs tick() to support a fan-out inside a used subgraph — today it
// throws notImplemented("tick: fan-out inside a used subgraph") whenever
// the CursorTree would need a use-descent wrapping a fan-out node. This
// capability was never actually blocked for runFlow (see
// use-fan-out.test.ts) — only tick()'s cursor-based path guards it.
describe("ticking a flow through a used subgraph that itself fans out", () => {
  let fanOutNodeId: string | undefined;
  const inner = defineGraph("tick-use-fan-out-inner", (flow) => {
    const entry = flow.step(outputs(() => "go"));
    fanOutNodeId = entry.id;
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const joinStep = flow.step(join((context) => context.inputs));
    flow.entry(entry);
    entry.then([a, b]);
    a.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  const outer = defineGraph("tick-use-fan-out-outer", (flow) => {
    const start = flow.step(outputs(() => "start"));
    const sub = flow.use(inner);
    flow.entry(start);
    start.then(sub, { prompt: (value) => userText(String(value)) });
    sub.then(flow.finish);
  });

  it("drives the subgraph's own fan-out via tick and reports its joined result", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const outcome = await tickUntilSuspended(outer, ready);

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    expect((outcome[0] as { result: unknown }).result).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("reports the nested branch cursors' parent as the fan-out node during an in-flight snapshot", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const seen: TickOutcome[] = [];
    let outcome = await tick(outer, ready);
    seen.push(outcome);
    const maxIterations = 20;
    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await tick(outer, ready);
      seen.push(outcome);
    }

    // at some point both branches were visible as independent lanes,
    // parented to the fan-out's own entry node inside the used subgraph —
    // same rule as a root-level fan-out, just one level deeper
    const multiCursorSnapshot = seen.find((snapshot) => snapshot.length > 1);
    expect(multiCursorSnapshot).toBeDefined();
    expect(multiCursorSnapshot?.every((cursor) => cursor.parent === fanOutNodeId)).toBe(true);

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
  });

  it("reconstructs the nested fan-out from the store alone, using a fresh Runtime per tick", async () => {
    const store = adapters.stores.memoryStore();

    async function freshTick(): Promise<TickOutcome> {
      const ready = await runtime({ models: neverCalled, bindings: [], store });
      return tick(outer, ready);
    }

    let outcome = await freshTick();
    const maxIterations = 20;
    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await freshTick();
    }

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    expect((outcome[0] as { result: unknown }).result).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
