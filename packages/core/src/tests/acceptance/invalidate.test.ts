import { describe, it, expect } from "vitest";
import { ai, defineGraph, runFlow, runtime, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { textOf, loggedEventTypes, neverCalled } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

describe("invalidate reruns a node out of band", () => {
  // A fresh counter per test, so `planRuns` starts at zero each time.
  function planThenImplement() {
    let planRuns = 0;
    return defineGraph("plan-then-implement", (flow) => {
      const plan = flow.step(
        outputs(() => {
          planRuns += 1;
          return `draft-${String(planRuns)}`;
        }),
      );
      const implement = flow.step((context) => {
        const draft = context.inputs[0] as string;
        return Promise.resolve(
          draft === "draft-1"
            ? context.invalidate(plan.id, { payload: { reason: userText("revise the plan") } })
            : context.output(`implemented:${draft}`),
        );
      });
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });
  }

  it("reruns the invalidated node, and its fresh output flows onward as normal", async () => {
    const graph = planThenImplement();
    const ready = await runtime({
      store: memoryStore(),
      extensions: [ai({ models: neverCalled, bindings: [] })],
    });

    const result = await runToCompletion(graph, userText("go"), ready);

    // plan reran with the reason, and implement finished on the new draft
    expect(result).toBe("implemented:draft-2");
  });

  it("appends an invalidation event between the two plan runs", async () => {
    const graph = planThenImplement();
    const store = memoryStore();
    const ready = await runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });

    await runToCompletion(graph, userText("go"), ready);

    // loose on exact position — confirm against reference.md's invalidate behaviour
    // when this slice is active
    expect(loggedEventTypes(store)).toContain("invalidation");
  });

  it("the rerun step can read the invalidate reason among its thread messages", async () => {
    let planRuns = 0;
    const graph = defineGraph("plan-reason", (flow) => {
      const plan = flow.step((context) => {
        planRuns += 1;
        return Promise.resolve(
          context.output({
            runNumber: planRuns,
            sawReason: context.thread.messages.some(
              (message) => textOf(message) === "revise the plan",
            ),
          }),
        );
      });
      const implement = flow.step((context) => {
        const draft = context.inputs[0] as { runNumber: number; sawReason: boolean };
        return Promise.resolve(
          draft.runNumber === 1
            ? context.invalidate(plan.id, { payload: { reason: userText("revise the plan") } })
            : context.output(draft),
        );
      });
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });

    const result = (await runToCompletion(
      graph,
      userText("go"),
      await runtime({
        store: memoryStore(),
        extensions: [ai({ models: neverCalled, bindings: [] })],
      }),
    )) as { runNumber: number; sawReason: boolean };

    expect(result.runNumber).toBe(2);
    expect(result.sawReason).toBe(true);
  });

  it("reruns on a distinct forked thread when threadAction is 'fork'", async () => {
    let planRuns = 0;
    const graph = defineGraph("plan-fork", (flow) => {
      let firstThreadId: unknown;
      const plan = flow.step(
        outputs((context) => {
          planRuns += 1;
          if (planRuns === 1) firstThreadId = context.thread.id;
          return context.thread.id;
        }),
      );
      const implement = flow.step((context) =>
        Promise.resolve(
          planRuns === 1
            ? context.invalidate(plan.id, { action: "fork" })
            : context.output({ firstThreadId, secondThreadId: context.thread.id }),
        ),
      );
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });

    // Deliberately still on `runFlow`, not `runToCompletion` (B2.9's sweep):
    // a payload-less fork leaves no event tagged with the minted scope, so
    // tick's replay silently falls back to the original thread and the rerun
    // never escapes it. The sibling case above passes under either driver only
    // because its `reason` payload happens to get logged on the new scope. See
    // the tracked problem "invalidate with threadAction 'fork' loses the forked
    // scope under tick" — flagged production-relevant, since driveFlow is what
    // live sessions run on.
    const result = (await runFlow(
      graph,
      userText("go"),
      await runtime({
        store: memoryStore(),
        extensions: [ai({ models: neverCalled, bindings: [] })],
      }),
    )) as { firstThreadId: unknown; secondThreadId: unknown };

    expect(result.secondThreadId).not.toBe(result.firstThreadId);
  });

  it("reruns on a blank thread when threadAction is 'new'", async () => {
    let planRuns = 0;
    const graph = defineGraph("plan-new-thread", (flow) => {
      const plan = flow.step(
        outputs((context) => {
          planRuns += 1;
          return context.thread.messages.length;
        }),
      );
      const implement = flow.step((context) => {
        const messageCount = context.inputs[0] as number;
        return Promise.resolve(
          planRuns === 1
            ? context.invalidate(plan.id, {
                action: "new",
                payload: { reason: userText("start fresh") },
              })
            : context.output(messageCount),
        );
      });
      flow.entry(plan);
      plan.then(implement);
      implement.then(flow.finish);
    });

    const result = await runToCompletion(
      graph,
      userText("go"),
      await runtime({
        store: memoryStore(),
        extensions: [ai({ models: neverCalled, bindings: [] })],
      }),
    );

    // a brand-new thread has just its own fresh seeded message (the reason, here)
    expect(result).toBe(1);
  });
});
