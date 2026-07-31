// B2.3 — edge functions (`run` on `then`/`when`/`otherwise`) plus the
// `edgeContext` hook. Two invariants under test, both load-bearing for an
// event-sourced engine:
//
// 1. An edge function runs exactly once, at the moment its route commits —
//    never again on a later replay of the same log (e.g. a process restart
//    re-driving an already-completed session, the way `driveFlow` would
//    after a real container restart; see multi-turn-replay-after-restart.test.ts
//    for the established pattern this borrows).
// 2. "Emit, don't mutate": only what an edge function commits through
//    `ctx.appendEvent` is durable. A value merely captured in a closure is
//    real during the live run that captured it, but provably unrecoverable
//    from a fresh replay of the log — the log, not process memory, is the
//    single source of truth tick() rebuilds from.

import { describe, it, expect } from "vitest";
import { defineGraph, runtime, driveFlow, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { EdgeContext, EdgeFn, Graph } from "../../index.js";
import { neverCalled } from "./support.js";
import { isCommittedEnvelope } from "../../session/envelope.js";

/** entry -> (edge fn fires here) -> after -> finish. `edgeFn` is the only
 * thing under test; `after` just passes through whatever the edge fn
 * returned, so a test can assert on the value the target node actually saw. */
function edgeFnFlow(edgeFn: EdgeFn): Graph {
  return defineGraph("edge-fn-flow", (flow) => {
    const start = flow.step(outputs(() => "start-value"));
    const after = flow.step(outputs((context) => context.inputs[0]));
    flow.entry(start);
    start.then(after, { run: edgeFn });
    after.then(flow.finish);
  });
}

describe("edge functions: run once, at routing commit", () => {
  it("does not re-invoke the edge fn when the same log is driven again after a restart", async () => {
    let calls = 0;
    const countingEdge: EdgeFn = (value, ctx: EdgeContext) => {
      calls += 1;
      ctx.appendEvent({ name: "edge-fired", payload: calls }, "signal");
      return value;
    };

    const store = memoryStore();
    const runtime1 = await runtime({ models: neverCalled, bindings: [], store });
    const graph1 = edgeFnFlow(countingEdge);
    const result1 = await driveFlow(graph1, runtime1);
    expect(result1).toBe("start-value");
    expect(calls).toBe(1);

    // Simulated restart: a brand-new runtime/graph pair against the same
    // store — driveFlow has nothing left to do but replay, exactly like
    // multi-turn-replay-after-restart.test.ts's own reattach simulation.
    const runtime2 = await runtime({ models: neverCalled, bindings: [], store });
    const graph2 = edgeFnFlow(countingEdge);
    const result2 = await driveFlow(graph2, runtime2);
    expect(result2).toBe("start-value");

    expect(calls).toBe(1);
    const signalCount = store
      .events()
      .filter(isCommittedEnvelope)
      .filter((envelope) => envelope.type === "signal").length;
    expect(signalCount).toBe(1);
  });
});

describe("edge functions: emit, don't mutate", () => {
  it("a value only captured in a closure never reappears from a fresh replay of the log", async () => {
    const captured1 = { value: undefined as string | undefined };
    const liveEdge: EdgeFn = (value, ctx: EdgeContext) => {
      // The unsafe half: a plain closure mutation, never logged.
      captured1.value = `mutated-${String(value)}`;
      // The safe half: the same fact, durably committed.
      ctx.appendEvent({ name: "durable-marker", payload: value }, "signal");
      return value;
    };

    const store = memoryStore();
    const runtime1 = await runtime({ models: neverCalled, bindings: [], store });
    await driveFlow(edgeFnFlow(liveEdge), runtime1);
    expect(captured1.value).toBe("mutated-start-value"); // real during the live run

    // Simulated restart: a fresh process has fresh memory — model that with
    // a brand-new captured cell nothing populates unless the edge fn actually
    // reruns. `edgeFn2` is the "same" edge function a restarted process would
    // rebuild, closing over this fresh, still-empty cell.
    const captured2 = { value: undefined as string | undefined };
    const edgeFn2: EdgeFn = (value, ctx: EdgeContext) => {
      captured2.value = `mutated-${String(value)}`;
      ctx.appendEvent({ name: "durable-marker", payload: value }, "signal");
      return value;
    };

    const runtime2 = await runtime({ models: neverCalled, bindings: [], store });
    const result = await driveFlow(edgeFnFlow(edgeFn2), runtime2);
    expect(result).toBe("start-value"); // the log alone still reaches the right answer

    // The mutation never reappears purely by replaying the log...
    expect(captured2.value).toBeUndefined();
    // ...while the durably-emitted fact was, and remains, recoverable —
    // logged exactly once, by the original live run, never re-appended.
    const markers = store
      .events()
      .filter(isCommittedEnvelope)
      .filter(
        (envelope) =>
          envelope.type === "signal" &&
          (envelope.event as { name: string }).name === "durable-marker",
      );
    expect(markers).toHaveLength(1);
  });
});
