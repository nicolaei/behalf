import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, provide, tool, userText } from "@behalf-js/core";
import type { Graph, ModelPort, Profile, AssistantMessage, SessionStore } from "@behalf-js/core";
import { memoryStore } from "@behalf-js/stores";
import { foldRun } from "../../eval/run.js";

/** A scripted assistant message with a single text block. */
function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 3, output: 5 },
  };
}

/** A scripted assistant message with a single tool call. */
function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 4, output: 2 },
  };
}

const search = tool<{ query: string }, { hits: string[] }>("search", "Searches for a query.");

/** The canonical "call model, loop back while it used tools, finish otherwise" agent graph. */
function agentGraph(profile: Profile): Graph {
  return defineGraph("fold-run-agent", (flow) => {
    const respond = flow.step(async (context) => context.output(await context.modelCall(profile)), {
      label: "respond",
    });
    flow.entry(respond);
    respond
      .when((result) => !(result as { usedTools: boolean }).usedTools, flow.finish)
      .otherwise(respond);
  });
}

async function runAgentOnce(): Promise<{ store: SessionStore; latencyInput: number }> {
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
  const store = memoryStore();
  const ready = await runtime({
    models: () => scriptedPort,
    bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
    store,
  });
  await runFlow(agentGraph(profile), userText("find x"), ready);
  return { store, latencyInput: 42 };
}

describe("foldRun", () => {
  it("output is the raw value of the last committed output envelope", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    // this agentGraph's last step outputs context.modelCall's ModelCallResult
    // directly — foldRun never special-cases it into the assistant's text;
    // that's what lastReply()/messages() are for.
    expect(run.output).toMatchObject({ usedTools: false, toolCalls: [] });
  });

  it("world and latency pass through unchanged", async () => {
    const { store } = await runAgentOnce();
    const world = { hits: [] as string[] };
    const run = foldRun(store.events(), world, 123);
    expect(run.world).toBe(world);
    expect(run.latency).toBe(123);
  });

  it("tools pairs each toolCall with its toolResult by correlationId", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({
      name: "search",
      input: { query: "x" },
      output: { hits: ["a"] },
    });
    expect(run.tools[0]?.isError).toBeUndefined();
  });

  it("traversal lists nodes entered in log order, including the loop-back", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    // "respond" runs twice: once producing a tool call, once finishing
    expect(run.traversal).toHaveLength(2);
    expect(run.traversal.every((entry) => entry.name === "respond")).toBe(true);
  });

  it("visits: the first visit to a thread has an empty input; a later visit's input is the previous output", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    expect(run.visits).toHaveLength(2);
    expect(run.visits[0]?.input).toEqual([]);
    expect(run.visits[1]?.input).toEqual([run.visits[0]?.output]);
  });

  it("usage sums token usage across every assistant message", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    // first assistant message: {input:4, output:2}; second: {input:3, output:5}
    expect(run.usage).toEqual({ input: 7, output: 7 });
  });

  it("lastReply() (no thread) returns the last assistant message overall", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    const reply = run.lastReply();
    expect(reply?.role).toBe("assistant");
    expect(reply?.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("messages() (no thread) returns every message logged, in order", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    const roles = run.messages().map((message) => message.role);
    expect(roles[0]).toBe("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
  });

  it("threads lists every thread touched, in first-seen order", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    expect(run.threads.length).toBeGreaterThanOrEqual(1);
  });

  it("lastReply(thread) and messages(thread) scope to that thread only", async () => {
    const { store } = await runAgentOnce();
    const run = foldRun(store.events(), undefined, 0);
    const threadId = run.threads[0]?.id;
    expect(threadId).toBeDefined();
    const reply = run.lastReply(threadId);
    expect(reply?.role).toBe("assistant");
    const messages = run.messages(threadId);
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("foldRun on a run with no tool calls", () => {
  async function runNoToolsAgent(): Promise<SessionStore> {
    const scriptedPort: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: () => Promise.resolve(assistantText("done immediately")),
    };
    const profile: Profile = { model: scriptedPort.model, system: "agent", tools: [] };
    const store = memoryStore();
    const ready = await runtime({ models: () => scriptedPort, bindings: [], store });
    await runFlow(agentGraph(profile), userText("hi"), ready);
    return store;
  }

  it("tools is empty when no tool was called", async () => {
    const store = await runNoToolsAgent();
    const run = foldRun(store.events(), undefined, 0);
    expect(run.tools).toEqual([]);
  });

  it("traversal has exactly one entry — no loop-back", async () => {
    const store = await runNoToolsAgent();
    const run = foldRun(store.events(), undefined, 0);
    expect(run.traversal).toHaveLength(1);
  });
});
