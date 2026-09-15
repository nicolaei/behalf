import { describe, it, expect } from "vitest";
import { ai, defineGraph, runtime, provide, tool, userText } from "../index.js";
import { abortLiveToolCalls } from "./tool-executor.js";
import { runToCompletion } from "@behalf-js/testing";
import { fakePort } from "@behalf-js/testing/ai";
import { memoryStore } from "@behalf-js/stores";
import { assistantToolCall } from "../tests/acceptance/support.js";

// Needs ToolContext.signal to be real: a handler that is running when the
// runtime cancels its call has no way to learn about it today, so a slow tool
// runs to completion however many times a human asks for it to stop.
describe("a tool handler is given a signal", () => {
  function searchGraph() {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const graph = defineGraph("tool-context-signal", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(
          await context.modelCall({ model: fakePort.model, system: "test", tools: [search] }),
        ),
      );
      flow.entry(respond);
      respond.then(flow.finish);
    });
    return { search, graph };
  }

  it("aborts that signal when the runtime cancels the call, and still commits an ordinary toolResult", async () => {
    const { search, graph } = searchGraph();
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let seenSignal: AbortSignal | undefined;

    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: () => ({
            model: fakePort.model,
            respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
          }),
          bindings: [
            provide(search, (_input, context) => {
              seenSignal = context.signal;
              started();
              // Honours the signal in its own idiom: returns partial work
              // rather than throwing, so the toolResult still commits.
              return new Promise<{ hits: string[] }>((resolve) => {
                context.signal.addEventListener("abort", () => {
                  resolve({ hits: [] });
                });
              });
            }),
          ],
        }),
      ],
    });

    const run = runToCompletion(graph, userText("go"), ready);
    await handlerStarted;
    expect(seenSignal?.aborted).toBe(false);

    abortLiveToolCalls(ready);
    await run;

    expect(seenSignal?.aborted).toBe(true);

    const result = store.events().find((e) => e.form === "committed" && e.type === "toolResult");
    expect(result).toBeDefined();
    const event =
      result?.form === "committed"
        ? (result.event as { output: unknown; isError?: boolean })
        : undefined;
    expect(event?.isError).toBeUndefined();
    expect(event?.output).toEqual({ hits: [] });
  });

  it("forgets a settled call, so a later cancellation reaches nothing", async () => {
    const { search, graph } = searchGraph();
    let seenSignal: AbortSignal | undefined;

    const ready = await runtime({
      store: memoryStore(),
      extensions: [
        ai({
          models: () => ({
            model: fakePort.model,
            respond: () => Promise.resolve(assistantToolCall("search", { query: "x" })),
          }),
          bindings: [
            provide(search, (input, context) => {
              seenSignal = context.signal;
              return Promise.resolve({ hits: [input.query] });
            }),
          ],
        }),
      ],
    });

    await runToCompletion(graph, userText("go"), ready);
    expect(seenSignal).toBeDefined();

    abortLiveToolCalls(ready);

    expect(seenSignal?.aborted).toBe(false);
  });
});
