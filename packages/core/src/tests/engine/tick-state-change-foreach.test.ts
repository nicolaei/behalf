import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, userInput, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, Runtime, SessionStore } from "../../index.js";
import { neverCalled, stateChanges } from "../acceptance/support.js";

// A review of the driveGraph/tick() unification (commit 31b1a10) found this
// case had no coverage either way: before that refactor, tick()'s own
// advanceForEachGroup gave every call a brand-new StateTracker with no memory
// of what a branch already emitted in an earlier tick() call — so a branch
// that pauses (its own waitFor) between two state-declaring nodes would
// re-fire the second one even if it repeated the first's value. The
// unification's ExecutionScope.descend() shares the log-rebuilt tracker
// instead, which should fix this as a side effect. This pins that down.
describe("stateChange dedupes across a paused forEach branch, resumed on a later tick() call", () => {
  function resume(item: string, text: string) {
    return {
      kind: "message" as const,
      message: {
        role: "user" as const,
        intent: "standard" as const,
        kind: `resume-${item}`,
        content: [{ type: "text" as const, text }],
      },
    };
  }

  function branchFor(item: string): Graph {
    return defineGraph(`tick-foreach-branch-${item}`, (flow) => {
      const before = flow.step(
        outputs(() => `${item}-before`),
        { state: "processing" },
      );
      const wait = flow.waitFor(userInput(`resume-${item}`));
      const after = flow.step(
        outputs(() => `${item}-after`),
        { state: "processing" },
      );
      flow.entry(before);
      before.then(wait);
      wait.then(after);
      after.then(flow.finish);
    });
  }

  const graph = defineGraph("tick-foreach-state-dedup", (flow) => {
    const produce = flow.step(outputs(() => ["a"]));
    const each = flow.forEach((output) => output as string[], branchFor);
    flow.entry(produce);
    produce.then(each);
    each.then(flow.finish);
  });

  async function freshTick(store: SessionStore) {
    const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
    return tickUntilSuspended(graph, ready);
  }

  it("emits one stateChange, not two, for a branch that repeats its own state after pausing", async () => {
    const store = memoryStore();

    await freshTick(store); // runs produce + the branch's `before`, parks at its own waitFor
    store.receive(resume("a", "go-ahead"));
    await freshTick(store); // resumes the branch, runs `after` — the SAME declared state

    expect(stateChanges(store)).toEqual([{ to: "processing" }]);
  });
});
