import { describe, it, expect } from "vitest";
import { tick } from "../../engine/runtime.js";
import type { TickOutcome } from "../../engine/runtime.js";
import { defineGraph, runtime, join, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled } from "../acceptance/support.js";

// Needs tick() to support fan-out — currently it throws
// notImplemented("tick: fan-out") whenever a step's outcome carries
// pendingInputs. This is the prerequisite for driving a fan-out flow one
// node at a time instead of only via runFlow's Promise.all-based runBranch.
describe("ticking a fan-out flow", () => {
  let fanOutNodeId!: string;
  const fanOut = defineGraph("tick-fan-out", (flow) => {
    const start = flow.step(outputs(() => "go"));
    fanOutNodeId = start.id;
    const a = flow.step(outputs(() => "a"));
    const b = flow.step(outputs(() => "b"));
    const joinStep = flow.step(join((context) => context.inputs));
    flow.entry(start);
    start.then([a, b]);
    a.then(joinStep);
    b.then(joinStep);
    joinStep.then(flow.finish);
  });

  it("reports fan-out branches as independent cursors, then folds to one root result", async () => {
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store: memoryStore(),
    });

    const seen: TickOutcome[] = [];
    let outcome = await tick(fanOut, ready);
    seen.push(outcome);

    // drive until every cursor is done, bounded so a real bug fails fast
    // with a clear assertion rather than hanging until vitest's own timeout
    const maxIterations = 20;
    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await tick(fanOut, ready);
      seen.push(outcome);
    }

    // at some point both branches were visible as independent, live cursors —
    // not collapsed into one status the way the old 3-way discriminant was
    expect(seen.some((snapshot) => snapshot.length > 1)).toBe(true);

    // every branch cursor visible mid-flight is parented to the fan-out node
    const intermediate = seen.find((snapshot) => snapshot.length > 1);
    if (!intermediate) throw new Error("expected an intermediate multi-cursor snapshot");
    for (const cursor of intermediate) {
      expect((cursor as { parent?: unknown }).parent).toBe(fanOutNodeId);
    }

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    // join()'s contract is declared-order inputs, not just membership —
    // arrayContaining would pass even if branches came back out of order
    expect((outcome[0] as { result: unknown }).result).toEqual(["a", "b"]);
  });

  it("resumes fan-out cursor state correctly even with a brand new Runtime object per tick — only the store persists", async () => {
    const store = memoryStore();

    // every tick gets its own fresh runtime() call — the only thing carried
    // between them is the store itself, nothing cached on a shared Runtime
    async function freshTick(): Promise<TickOutcome> {
      const ready = await runtime({ models: neverCalled, bindings: [], store });
      return tick(fanOut, ready);
    }

    const seen: TickOutcome[] = [];
    let outcome = await freshTick();
    seen.push(outcome);

    const maxIterations = 20;
    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await freshTick();
      seen.push(outcome);
    }

    expect(seen.some((snapshot) => snapshot.length > 1)).toBe(true);

    const intermediate = seen.find((snapshot) => snapshot.length > 1);
    if (!intermediate) throw new Error("expected an intermediate multi-cursor snapshot");
    for (const cursor of intermediate) {
      expect((cursor as { parent?: unknown }).parent).toBe(fanOutNodeId);
    }

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    expect((outcome[0] as { result: unknown }).result).toEqual(["a", "b"]);
  });
});
