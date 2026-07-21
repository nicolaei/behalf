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
import { assistantToolCall, loggedEventTypes } from "./support.js";

// Story 7 of the decoupled model/tool-calls epic: forEach + toolCall resolve
// a real, registered tool call end-to-end, genuinely parked (not resolved by
// the test manually committing a toolResult) — the decoupled executor from
// Story 6 is what resolves it, off to the side, while forEach's waitFor node
// is what's actually parked waiting.
describe("forEach + toolCall resolve one real tool call", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function toolBranch(item: unknown): Graph {
    const { correlationId } = item as { correlationId: string; name: string };
    return defineGraph(`single-tool-${correlationId}`, (flow) => {
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

  it("parks on a real tool call and resolves once the executor commits its result", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const gate = deferred<{ hits: string[] }>();
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };

    const flow = defineGraph("foreach-toolcall-single", (flowBuilder) => {
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
      bindings: [provide(search, () => gate.promise)],
      store,
    });

    const resultPromise = runFlow(flow, userText("find x"), ready);

    // Give the executor a turn to run — it should find nothing to resolve
    // yet, since the handler is still gated shut. The flow must not have
    // completed: forEach is genuinely parked, not resolved by anyone.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loggedEventTypes(store)).toContain("toolCall");
    expect(loggedEventTypes(store)).not.toContain("toolResult");

    gate.resolve({ hits: ["a", "b"] });
    const result = await resultPromise;

    expect(result).toEqual([{ correlationId: "1", output: { hits: ["a", "b"] } }]);
    const types = loggedEventTypes(store);
    expect(types.indexOf("toolCall")).toBeLessThan(types.indexOf("toolResult"));
  });
});
