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
import type {
  Graph,
  Message,
  ModelCallResult,
  ModelPort,
  Profile,
  WaitForResult,
} from "../../index.js";
import { assistantText, assistantToolCall, loggedEventTypes } from "./support.js";

// Rewritten for the non-blocking modelCall contract (Story 6 of the
// decoupled model/tool-calls epic): modelCall no longer waits for tool calls
// to resolve before returning, so "the agent loop" now has to model waiting
// for and folding tool results explicitly, via forEach + toolCall, instead
// of relying on modelCall having already done that work by the time the
// step returns.
describe("the agent loop", () => {
  // Deferred to a factory, not built at describe-scope: `tool()` isn't real
  // yet, and a describe body runs even when its `it`s are skipped.
  function scriptedFixture() {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    let calls = 0;
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? assistantToolCall("search", { query: "x" }) : assistantText("done"),
        );
      },
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [search] };

    function toolBranch(item: unknown): Graph {
      const { correlationId } = item as { correlationId: string; name: string };
      return defineGraph(`agent-loop-tool-${correlationId}`, (flow) => {
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

    const agentLoop = defineGraph("agent-loop", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      const each = flow.forEach((output) => (output as ModelCallResult).toolCalls, toolBranch);
      const foldAndLoop = flow.step(async (context) => {
        const results = context.inputs[0] as { correlationId: string; output: unknown }[];
        return context.compact((messages) =>
          Promise.resolve([
            ...messages,
            ...results.map((result): Message => ({
              role: "tool",
              content: [
                { type: "toolResult", correlationId: result.correlationId, output: result.output },
              ],
            })),
          ]),
        );
      });
      const finalize = flow.step(
        outputs((context) => {
          const last = context.thread.messages.at(-1);
          const block = last?.content.find((candidate) => candidate.type === "text");
          return block?.type === "text" ? block.text : "";
        }),
      );

      flow.entry(respond);
      respond.then(each);
      each.when((results) => (results as unknown[]).length > 0, foldAndLoop).otherwise(finalize);
      foldAndLoop.then(respond);
      finalize.then(flow.finish);
    });

    return { agentLoop, scriptedPort, search, callCount: () => calls };
  }

  it("keeps looping while the model calls tools, finishes once it doesn't", async () => {
    const { agentLoop, scriptedPort, search, callCount } = scriptedFixture();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store: adapters.stores.memoryStore(),
    });

    const result = await runFlow(agentLoop, userText("find x"), ready);

    // called twice — once producing a tool call, once finishing
    expect(callCount()).toBe(2);
    expect(result).toBe("done");
  });

  it("appends a tool call and its result to the session log", async () => {
    const { agentLoop, scriptedPort, search } = scriptedFixture();
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => scriptedPort,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store,
    });

    await runFlow(agentLoop, userText("find x"), ready);

    const types = loggedEventTypes(store);
    expect(types).toContain("toolCall");
    expect(types).toContain("toolResult");
  });
});
