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
import { assistantToolCall, loggedEnvelopes } from "./support.js";

// Reproduces a stray thread id observed live in examples/multi-step-agent: every
// time a forEach tool-call branch subgraph reaches its own internal `finish`,
// the engine folds it back into the outer flow via a "output" event (see
// tick.ts's use-descent completion handling) — and that event was seen
// carrying a freshly-minted thread id nobody else in the log ever references,
// instead of the flow's own live thread.
describe("forEach tool-call branch completion stays on the flow's own thread", () => {
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

  it("commits the branch's own finish-fold 'output' event on the same thread as everything else", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };

    const flow = defineGraph("foreach-single-thread", (flowBuilder) => {
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
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store,
    });

    await runFlow(flow, userText("find x"), ready);

    // Every committed envelope belongs to the one real conversation thread —
    // no stray thread id should appear anywhere in the log, including the
    // "output" event the forEach branch's own internal finish folds back
    // with once it completes.
    const threadIds = new Set(loggedEnvelopes(store).map((envelope) => envelope.threadId));
    expect(threadIds.size).toBe(1);
  });
});
