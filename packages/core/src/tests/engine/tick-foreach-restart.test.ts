import { describe, it, expect } from "vitest";
import { tick } from "../../engine/runtime.js";
import type { TickOutcome } from "../../engine/runtime.js";
import { defineGraph, runtime, provide, tool, outputs, toolCall } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, ModelCallResult, ModelPort, Profile, WaitForResult } from "../../index.js";
import { assistantToolCalls } from "../acceptance/support.js";

// Story 9 of the decoupled model/tool-calls epic: tick() must be able to
// resume mid-forEach after a simulated restart — one branch's tool call
// already resolved, the other still pending, reconstructed purely from the
// log with a fresh Runtime each tick (same pattern as
// tick-use-fan-out.test.ts's "reconstructs ... using a fresh Runtime per
// tick"). tick.ts has no forEach-kind handling yet — replayPosition needs
// extending to reconstruct forEach branch state (which items existed, which
// resolved) from committed events alone.
describe("tick() resumes mid-forEach after a simulated restart", () => {
  function branch(item: unknown): Graph {
    const { correlationId } = item as { correlationId: string; name: string };
    return defineGraph(`restart-branch-${correlationId}`, (flow) => {
      const wait = flow.waitFor(toolCall(correlationId));
      const shape = flow.step(
        outputs((context) => {
          const result = context.inputs[0] as WaitForResult;
          return { correlationId, output: result.result };
        }),
      );
      flow.entry(wait);
      wait.then(shape);
      shape.then(flow.finish);
    });
  }

  it("survives a restart with one branch resolved and one still pending", async () => {
    const alpha = tool<{ n: number }, { n: number }>("alpha", "Tool alpha.");
    const beta = tool<{ n: number }, { n: number }>("beta", "Tool beta.");
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () =>
        Promise.resolve(
          assistantToolCalls([
            { name: "alpha", input: { n: 1 } },
            { name: "beta", input: { n: 2 } },
          ]),
        ),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [alpha, beta] };

    const outer = defineGraph("restart-mid-foreach", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      const each = flow.forEach((output) => (output as ModelCallResult).toolCalls, branch);
      flow.entry(respond);
      respond.then(each);
      each.then(flow.finish);
    });

    const store = memoryStore();

    // alpha resolves fast via a real, registered binding — beta has no
    // binding at all, standing in for "whatever eventually resolves it
    // arrives after the restart, independent of this process."
    async function freshTick(): Promise<TickOutcome> {
      const ready = await runtime({
        models: () => scriptedPort,
        bindings: [provide(alpha, () => Promise.resolve({ n: 10 }))],
        store,
      });
      return tick(outer, ready);
    }

    let outcome = await freshTick();
    const maxIterations = 20;
    for (
      let i = 0;
      i < maxIterations && outcome.some((cursor) => cursor.status !== "done") && i < 5;
      i++
    ) {
      outcome = await freshTick();
    }

    // Simulate a restart: the process that would've resolved beta never
    // did — a different one commits its result directly to the log.
    store.append({ correlationId: "2", output: { n: 20 } }, { type: "toolResult" });

    for (let i = 0; i < maxIterations && outcome.some((cursor) => cursor.status !== "done"); i++) {
      outcome = await freshTick();
    }

    expect(outcome).toHaveLength(1);
    expect(outcome).toMatchObject([{ status: "done" }]);
    expect((outcome[0] as { result: unknown }).result).toEqual(
      expect.arrayContaining([
        { correlationId: "1", output: { n: 10 } },
        { correlationId: "2", output: { n: 20 } },
      ]),
    );
  });
});
