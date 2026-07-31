import { describe, it, expect } from "vitest";
import { tick, seed } from "../../runtime/runtime.js";
import type { TickOutcome, Runtime } from "../../runtime/runtime.js";
import { defineGraph, runtime, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, SessionStore } from "../../index.js";
import { neverCalled, loggedEventTypes } from "../acceptance/support.js";

// invalidate has the exact same replay gap compact used to have, confirmed
// in the design doc (.plans/compaction-redesign-overview.md, "Position
// tracking stays a separate fix") — and it's worse: `commitInvalidation`
// appends only an "invalidation" event, never an "output" event for the
// step that invalidated. Unlike a normal step, replayPosition has NOTHING
// to recognize that step as already-completed, so a fresh replay lands back
// on it and re-runs it — re-invoking `context.invalidate(...)` again, which
// re-applies threadAction (here: "fork") and appends a SECOND invalidation
// event. Left unfixed, every fresh tick()/driveFlow replay would grow the
// log by one more spurious invalidation, forever, without ever actually
// re-running the invalidated target.
describe("replay recognizes an invalidating step as already-completed", () => {
  function fixture(name: string, planRunsRef: { count: number }): Graph {
    return defineGraph(name, (flow) => {
      const plan = flow.step(
        outputs(() => {
          planRunsRef.count += 1;
          return `draft-${String(planRunsRef.count)}`;
        }),
      );
      const implement = flow.step((context) => {
        const draft = context.inputs[0] as string;
        return Promise.resolve(
          draft === "draft-1"
            ? context.invalidate(plan.id, { threadAction: "fork" })
            : context.output(`implemented:${draft}`),
        );
      });
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });
  }

  it("routes past a replayed invalidation event to its target instead of re-running the invalidating step", async () => {
    const planRunsRef = { count: 0 };
    const graph = fixture("tick-replay-invalidates", planRunsRef);
    const store: SessionStore = memoryStore();

    // Every call below gets a BRAND NEW Runtime object, same store — the
    // exact technique that caught the original compact bug: nothing may
    // survive a tick() call except what's already committed to the log.
    // tick()'s own one-step-per-call budget (see tick.ts) means no waitFor
    // is needed to force a pause between steps: `plan` and `implement` each
    // land in their own call.
    async function freshTick(): Promise<TickOutcome> {
      const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
      return tick(graph, ready);
    }

    seed(graph, undefined, await runtime({ models: neverCalled, bindings: [], store }));

    await freshTick(); // runs plan (draft-1), reports active at implement
    await freshTick(); // runs implement: draft-1 -> invalidates plan (fork), reports active at plan

    // The critical call: a fresh replay must recognize the just-logged
    // "invalidation" event as implement's own completion and route straight
    // to `plan` — NOT re-run `implement` (which would re-invalidate).
    await freshTick();

    // Exactly one invalidation ever logged. An unfixed replay would have
    // appended a second one on the call above (implement re-running with
    // the same "draft-1" input, since plan was never actually revisited).
    const invalidationCount = loggedEventTypes(store).filter(
      (type) => type === "invalidation",
    ).length;
    expect(invalidationCount).toBe(1);

    // plan really did get revisited exactly once more (its second run),
    // producing draft-2 — proof position actually moved to the target, not
    // just that the invalidation count stayed low by accident.
    expect(planRunsRef.count).toBe(2);

    // Drive the rest of the way home: implement finishes on draft-2.
    const final = await freshTick(); // runs implement: draft-2 -> output, finish

    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ status: "done", result: "implemented:draft-2" });
    expect(planRunsRef.count).toBe(2);
  });
});
