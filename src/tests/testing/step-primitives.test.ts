import { describe, it, expect } from "vitest";
import { stepOnce, stepUntilBlocked, stepUntil, atNode } from "../../testing/index.js";
import { StepUntilError } from "../../testing/errors.js";
import { defineGraph, runtime, adapters, outputs } from "../../index.js";
import type { Handle } from "../../index.js";
import { neverCalled, textOf } from "../acceptance/support.js";

describe("stepOnce", () => {
  const flow = defineGraph("step-once", (flowBuilder) => {
    const first = flowBuilder.step(outputs(() => "go"));
    const second = flowBuilder.step(outputs((context) => `${String(context.inputs[0])}-done`));
    flowBuilder.entry(first);
    first.then(second);
    second.then(flowBuilder.finish);
  });

  it("advances exactly one lane per call", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const first = await stepOnce(flow, ready);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "active" });

    const second = await stepOnce(flow, ready);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ status: "done", result: "go-done" });
  });
});

describe("stepUntilBlocked", () => {
  const flow = defineGraph("step-until-blocked", (flowBuilder) => {
    const first = flowBuilder.step(outputs(() => "go"));
    const wait = flowBuilder.waitFor("follow-up");
    const second = flowBuilder.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    flowBuilder.entry(first);
    first.then(wait);
    wait.then(second);
    second.then(flowBuilder.finish);
  });

  it("drives until every lane is parked or done", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const parked = await stepUntilBlocked(flow, ready);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: "parked", waitingFor: ["follow-up"] });
  });
});

describe("stepUntil", () => {
  it("stops once atNode(step) is satisfied", async () => {
    let targetStep: Handle | undefined;
    const flow = defineGraph("step-until-atnode", (flowBuilder) => {
      const first = flowBuilder.step(outputs(() => "go"));
      const second = flowBuilder.step(outputs(() => "second"));
      const third = flowBuilder.step(outputs(() => "third"));
      targetStep = second;
      flowBuilder.entry(first);
      first.then(second);
      second.then(third);
      third.then(flowBuilder.finish);
    });
    if (!targetStep) throw new Error("unreachable: targetStep not set by the graph builder");
    const target = targetStep;
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const state = await stepUntil(flow, ready, atNode(target));

    expect(state.some((lane) => lane.node === target.id)).toBe(true);
  });

  it("throws StepUntilError('stalled') when every lane is parked/done and condition never met", async () => {
    const flow = defineGraph("step-until-stalled", (flowBuilder) => {
      const first = flowBuilder.step(outputs(() => "go"));
      const wait = flowBuilder.waitFor("follow-up");
      flowBuilder.entry(first);
      first.then(wait);
      wait.then(flowBuilder.finish);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    await expect(stepUntil(flow, ready, () => false)).rejects.toThrow(StepUntilError);

    try {
      await stepUntil(flow, ready, () => false);
      expect.unreachable("expected stepUntil to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StepUntilError);
      expect((error as StepUntilError).reason).toBe("stalled");
    }
  });

  it("throws StepUntilError('budget-exceeded') when maxSteps is exhausted with lanes still active", async () => {
    // A -> B -> A with no finish condition — a real, always-active cycle
    // (same shape multi-node-cycle.test.ts uses), so stepUntil's condition
    // never gets a chance to be satisfied by a genuine stall — only the
    // maxSteps budget can end this.
    const flow = defineGraph("step-until-cycle", (flowBuilder) => {
      const a = flowBuilder.step(outputs(() => "again"));
      const b = flowBuilder.step(outputs((context) => context.inputs[0]));
      flowBuilder.entry(a);
      a.then(b);
      b.then(a);
    });
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    await expect(stepUntil(flow, ready, () => false, { maxSteps: 5 })).rejects.toThrow(
      StepUntilError,
    );

    try {
      await stepUntil(flow, ready, () => false, { maxSteps: 5 });
      expect.unreachable("expected stepUntil to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(StepUntilError);
      expect((error as StepUntilError).reason).toBe("budget-exceeded");
    }
  });
});
