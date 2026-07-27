import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, stateChanges } from "./support.js";

describe("stateChange: fires only when a node's declared `state` differs from the last one seen", () => {
  // Four nodes: two share "red" (proving the event collapses repeats), one
  // carries no state at all (proving it's invisible to the state machine,
  // not a silent transition to "undefined"), and one moves to "green"
  // (proving a real transition still fires, with the prior value as `from`).
  const trafficLight = defineGraph("traffic-light", (flow) => {
    const check1 = flow.step(
      outputs(() => "checked"),
      { label: "check-1", state: "red" },
    );
    const check2 = flow.step(
      outputs(() => "checked-again"),
      { label: "check-2", state: "red" },
    );
    const log = flow.step(
      outputs(() => "logged"),
      { label: "log" },
    );
    const approve = flow.step(
      outputs(() => "approved"),
      { label: "approve", state: "green" },
    );
    flow.entry(check1);
    check1.then(check2);
    check2.then(log);
    log.then(approve);
    approve.then(flow.finish);
  });

  it("fires once entering a state, not once per node that shares it", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(trafficLight, userText("go"), ready);

    const redChanges = stateChanges(store).filter((change) => change.to === "red");
    expect(redChanges).toHaveLength(1);
  });

  it("omits `from` on the very first state a run enters", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(trafficLight, userText("go"), ready);

    expect(stateChanges(store)[0]).toEqual({ to: "red" });
  });

  it("fires again on a real transition, carrying the prior state as `from`", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(trafficLight, userText("go"), ready);

    expect(stateChanges(store)).toEqual([{ to: "red" }, { from: "red", to: "green" }]);
  });

  it("does not fire for a node with no declared state", async () => {
    // "log" runs between "red" and "green" and carries no `state` — total
    // count stays 2, not 3, so a state-less node never resets or interrupts
    // an in-progress phase.
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });
    await runFlow(trafficLight, userText("go"), ready);

    expect(stateChanges(store)).toHaveLength(2);
  });
});

describe("stateChange works on any node kind, not just step", () => {
  // `state` is a property of "being at this node" — a `waitFor` node
  // declares one exactly like a `step` does.
  const approvalGate = defineGraph("approval-gate", (flow) => {
    const request = flow.step(
      outputs(() => "requested"),
      { state: "red" },
    );
    const wait = flow.waitFor(userInput("approval"), { state: "yellow" });
    const done = flow.step(
      outputs(() => "done"),
      { state: "green" },
    );
    flow.entry(request);
    request.then(wait);
    wait.then(done);
    done.then(flow.finish);
  });

  it("emits stateChange for a waitFor node's own state", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(approvalGate, userText("go"), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "approval",
        content: [{ type: "text", text: "yes" }],
      },
    });
    await done;

    expect(stateChanges(store)).toEqual([
      { to: "red" },
      { from: "red", to: "yellow" },
      { from: "yellow", to: "green" },
    ]);
  });
});
