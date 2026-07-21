import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  provide,
  tool,
  userText,
  adapters,
  outputs,
  toolCall,
} from "../../index.js";
import type { Graph, ModelCallResult, ModelPort, Profile, WaitForResult } from "../../index.js";
import { assistantToolCalls, loggedEventTypes } from "./support.js";

// Story 8 of the decoupled model/tool-calls epic: several real tool calls
// requested in one model turn, resolved out of order by the decoupled
// executor. Proves folding tracks item/branch order, not resolution order
// — same invariant as Story 3, now with real dispatch instead of a bare
// waitFor(userInput) branch.
describe("multiple real tool calls in one turn", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function toolBranch(item: unknown): Graph {
    const { correlationId } = item as { correlationId: string; name: string };
    return defineGraph(`multi-tool-${correlationId}`, (flow) => {
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

  it("resolves all three, folded in request order, even though they finish out of order", async () => {
    const alpha = tool<{ n: number }, { n: number }>("alpha", "Tool alpha.");
    const beta = tool<{ n: number }, { n: number }>("beta", "Tool beta.");
    const gamma = tool<{ n: number }, { n: number }>("gamma", "Tool gamma.");
    const gates = {
      "1": deferred<{ n: number }>(),
      "2": deferred<{ n: number }>(),
      "3": deferred<{ n: number }>(),
    };
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () =>
        Promise.resolve(
          assistantToolCalls([
            { name: "alpha", input: { n: 1 } },
            { name: "beta", input: { n: 2 } },
            { name: "gamma", input: { n: 3 } },
          ]),
        ),
    };
    const profile: Profile = {
      model: scriptedPort.model,
      system: "agent",
      tools: [alpha, beta, gamma],
    };

    const flow = defineGraph("foreach-toolcall-multi", (flowBuilder) => {
      const respond = flowBuilder.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      const each = flowBuilder.forEach(
        (output) => (output as ModelCallResult).toolCalls,
        toolBranch,
      );
      flowBuilder.entry(respond);
      respond.then(each);
      each.then(flowBuilder.finish);
    });

    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [
        provide(alpha, () => gates["1"].promise),
        provide(beta, () => gates["2"].promise),
        provide(gamma, () => gates["3"].promise),
      ],
      store,
    });

    const resultPromise = runFlow(flow, userText("go"), ready);

    // Resolve out of request order: 3, then 1, then 2.
    gates["3"].resolve({ n: 30 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    gates["1"].resolve({ n: 10 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    gates["2"].resolve({ n: 20 });

    const result = await resultPromise;

    expect(result).toEqual([
      { correlationId: "1", output: { n: 10 } },
      { correlationId: "2", output: { n: 20 } },
      { correlationId: "3", output: { n: 30 } },
    ]);
    expect(loggedEventTypes(store).filter((type) => type === "toolCall")).toHaveLength(3);
    expect(loggedEventTypes(store).filter((type) => type === "toolResult")).toHaveLength(3);
  });
});
