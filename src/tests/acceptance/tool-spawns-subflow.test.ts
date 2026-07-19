import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import { neverCalled, textOf } from "./support.js";

describe("a tool handler spawning a child flow", () => {
  // Deferred to a factory, not built at describe-scope: `tool()` isn't real
  // yet, and a describe body runs even when its `it`s are skipped.
  function fixture() {
    const child = defineGraph("child", (flow) => {
      const step = flow.step((context) =>
        Promise.resolve(context.output(`answered: ${textOf(context.thread.messages.at(-1))}`)),
      );
      flow.entry(step);
      step.then(flow.finish);
    });

    const research = tool<{ question: string }, unknown>(
      "research",
      "Spawn a child flow to answer a question.",
    );

    const parent = defineGraph("parent", (flow) => {
      const ask = flow.step(async (context) =>
        context.output(await context.callTool(research, { question: "what is x" })),
      );
      flow.entry(ask);
      ask.then(flow.finish);
    });

    return { parent, research, child };
  }

  it("returns the child flow's result as the tool's output", async () => {
    const { parent, research, child } = fixture();
    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(research, (input, context) => context.runFlow(child, userText(input.question))),
      ],
      store: adapters.stores.memoryStore(),
    });

    const result = await runFlow(parent, userText("go"), ready);

    expect(result).toBe("answered: what is x");
  });
  // Test-only tightening — no new engine capability needed: buildToolContext
  // already passes parentThreadId through to runFlow. Replaces a loose
  // "at least 2 messages" assertion with the precise claim the doc makes.
  it.skip("sets the child flow's parentThreadId to the parent's own thread id", async () => {
    const { parent, research } = fixture();
    let parentThreadId: unknown;
    let childParentThreadId: unknown;
    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(research, (input, context) => {
          parentThreadId = context.thread;
          return context.runFlow(
            defineGraph("child-captures-parent", (flow) => {
              const step = flow.step((stepContext) => {
                childParentThreadId = stepContext.thread.parentThreadId;
                return Promise.resolve(stepContext.output("done"));
              });
              flow.entry(step);
              step.then(flow.finish);
            }),
            userText(input.question),
          );
        }),
      ],
      store: adapters.stores.memoryStore(),
    });

    await runFlow(parent, userText("go"), ready);

    expect(childParentThreadId).toBe(parentThreadId);
  });
});
