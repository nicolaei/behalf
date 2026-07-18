import { describe, it, expect, beforeEach } from "vitest";
import { defineGraph, runFlow, runtime, userText, adapters, outputs } from "../../index.js";
import type { SessionStore } from "../../index.js";
import { neverCalled, loggedEventTypes } from "./support.js";

describe.skip("interrupt fires wherever the graph currently is", () => {
  const withInterrupt = defineGraph("with-interrupt", (flow) => {
    const wait = flow.waitFor("resume");
    const afterWait = flow.step(outputs(() => "resumed"));
    const cancelled = flow.interrupt(
      "cancel",
      outputs(() => "cancelled"),
    );

    flow.entry(wait);
    wait.then(afterWait);
    afterWait.then(flow.finish);
    cancelled.then(flow.finish);
  });

  let store: SessionStore;
  let done: Promise<unknown>;

  beforeEach(async () => {
    store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // parked at `waitFor("resume")`; a "cancel" message (the interrupt's kind) arrives instead
    // NOTE: submit timing is the same known open concern as waitFor's own test.
    done = runFlow(withInterrupt, userText("go"), ready);
    store.submit({ role: "user", intent: "standard", kind: "cancel", content: [] });
  });

  it("bypasses the waiting path when the interrupt's kind arrives instead of the waited-for kind", async () => {
    expect(await done).toBe("cancelled");
  });

  it("appends the interrupt's output to the session log", async () => {
    await done;

    // loose on exact shape — confirm against reference.md's interrupt behaviour
    // when this slice is active
    expect(loggedEventTypes(store)).toContain("output");
  });
});
