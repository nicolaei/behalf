import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, userInput, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, Runtime, SessionStore } from "../../index.js";
import { neverCalled, stateChanges } from "../acceptance/support.js";

// tick() reconstructs cursor position purely from the store on every call
// (see tick-and-resume.test.ts) — stateChange tracking must survive that same
// reconstruction, not just a single driveGraph/runFlow call, or a live,
// resumable session would see a state it already entered "re-enter" itself
// every time a fresh tick() call happens to land on a same-state node.
describe("stateChange survives across separate tick() calls, not just within one runFlow", () => {
  function followUp(text: string) {
    return {
      kind: "message" as const,
      message: {
        role: "user" as const,
        intent: "standard" as const,
        kind: "follow-up",
        content: [{ type: "text" as const, text }],
      },
    };
  }

  // A brand-new Runtime per call, only the store persists — the strongest form
  // of "position/state came from the log, not from anything tick() carried in
  // its own closures," matching tick-and-resume.test.ts's own third case.
  async function freshTick(graph: Graph, store: SessionStore) {
    const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
    return tickUntilSuspended(graph, ready);
  }

  it("does not re-emit a state already established on an earlier tick() call", async () => {
    const graph = defineGraph("tick-state-dedup", (flow) => {
      const start = flow.step(outputs(() => "go"), { state: "red" });
      const gate = flow.waitFor(userInput("follow-up"));
      const after = flow.step(outputs(() => "done"), { state: "red" });
      flow.entry(start);
      start.then(gate);
      gate.then(after);
      after.then(flow.finish);
    });
    const store = memoryStore();

    await freshTick(graph, store); // runs `start`, parks at `gate`
    store.receive(followUp("go-ahead"));
    await freshTick(graph, store); // resumes, runs `after` — same declared state

    expect(stateChanges(store)).toEqual([{ to: "red" }]);
  });

  it("carries the correct `from` across tick() calls on a real transition", async () => {
    const graph = defineGraph("tick-state-from", (flow) => {
      const start = flow.step(outputs(() => "go"), { state: "red" });
      const gate = flow.waitFor(userInput("follow-up"));
      const after = flow.step(outputs(() => "done"), { state: "green" });
      flow.entry(start);
      start.then(gate);
      gate.then(after);
      after.then(flow.finish);
    });
    const store = memoryStore();

    await freshTick(graph, store); // runs `start`, parks at `gate`
    store.receive(followUp("go-ahead"));
    await freshTick(graph, store); // resumes, runs `after` — a real transition

    expect(stateChanges(store)).toEqual([{ to: "red" }, { from: "red", to: "green" }]);
  });
});
