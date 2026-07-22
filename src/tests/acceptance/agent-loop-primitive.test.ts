import { describe, it, expect } from "vitest";
import { agentLoop, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type { Message, Model, ModelPort, Profile, Tool } from "../../index.js";
import {
  assistantToolCall,
  assistantToolCalls,
  assistantText,
  loggedEnvelopes,
  orphanedToolCallIds,
  at,
} from "./support.js";

// agentLoop is the library's own reusable "run a model, wait for every tool
// call it made, fold their results into one combined message, loop" graph —
// the generalized, exported version of agent-loop.test.ts's hand-rolled
// forEach + waitFor(toolCall(id)) + compact pattern. examples/simple-chat's
// chat.ts should use this instead of hand-rolling its own (buggy) loop.
const CALL_COUNTS = [1, 2] as const;
const MODEL: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

function toolsFor(count: number): Tool[] {
  return count === 1
    ? [tool<{ query: string }, { hits: string[] }>("search", "Search the web.")]
    : [
        tool<{ query: string }, { hits: string[] }>("search", "Search the web."),
        tool<{ city: string }, { forecast: string }>("weather", "Get the weather."),
      ];
}

function firstReply(tools: ReturnType<typeof toolsFor>): Message {
  return tools.length === 1
    ? assistantToolCall(at(tools, 0).name, { query: "x" })
    : assistantToolCalls(
        tools.map((t, i) => ({ name: t.name, input: i === 0 ? { query: "x" } : { city: "Oslo" } })),
      );
}

describe.each(CALL_COUNTS)("agentLoop, %i simultaneous tool call(s)", (count) => {
  it("finishes, and the model's second call sees every tool call paired with its result", async () => {
    const tools = toolsFor(count);
    const profile: Profile = { model: MODEL, system: "agent", tools };
    const capturedMessages: Message[][] = [];
    let call = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: (_profile, messages) => {
        capturedMessages.push(messages);
        call += 1;
        return Promise.resolve(call === 1 ? (firstReply(tools) as never) : assistantText("done"));
      },
    };

    const ready = await runtime({
      models: () => port,
      bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
      store: adapters.stores.memoryStore(),
    });

    const result = await runFlow(agentLoop(profile), userText("go"), ready);

    expect(result).toBe("done");
    expect(call).toBe(2);
    expect(orphanedToolCallIds(at(capturedMessages, 1))).toEqual([]);
  });

  it("logs the collected tool results as one message event on the thread, in call order", async () => {
    const tools = toolsFor(count);
    const profile: Profile = { model: MODEL, system: "agent", tools };
    let call = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: () => {
        call += 1;
        return Promise.resolve(call === 1 ? (firstReply(tools) as never) : assistantText("done"));
      },
    };
    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
      store,
    });

    await runFlow(agentLoop(profile), userText("go"), ready);

    const toolMessages = loggedEnvelopes(store).filter(
      (e) => e.type === "message" && (e.event as { message: Message }).message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1); // one combined message, never one per call

    const message = (at(toolMessages, 0).event as { message: Message }).message;
    const resultIds = message.content
      .filter((b): b is Extract<typeof b, { type: "toolResult" }> => b.type === "toolResult")
      .map((b) => b.correlationId);
    expect(resultIds).toEqual(tools.map((_, i) => String(i + 1))); // "1", "2" — call order
    expect(at(toolMessages, 0).threadId).toBeDefined();
  });

  it("keeps each thread's collected results on its own thread, even when correlationIds collide", async () => {
    const tools = toolsFor(count);
    const scriptFor = (): ModelPort["respond"] => {
      let call = 0;
      return () => {
        call += 1;
        return Promise.resolve(call === 1 ? (firstReply(tools) as never) : assistantText("done"));
      };
    };
    const respondA = scriptFor();
    const respondB = scriptFor(); // both scripts reuse correlationIds "1"/"2" — deliberate collision
    const profileA: Profile = { model: MODEL, system: "agent-A", tools };
    const profileB: Profile = { model: MODEL, system: "agent-B", tools };

    const store = adapters.stores.memoryStore();
    const ready = await runtime({
      models: () => ({
        model: MODEL,
        respond: (p, m, s) => (p.system === "agent-A" ? respondA(p, m, s) : respondB(p, m, s)),
      }),
      bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
      store,
    });

    const [resultA, resultB] = await Promise.all([
      runFlow(agentLoop(profileA), userText("go A"), ready),
      runFlow(agentLoop(profileB), userText("go B"), ready),
    ]);

    expect([resultA, resultB]).toEqual(["done", "done"]);

    const toolMessages = loggedEnvelopes(store).filter(
      (e) => e.type === "message" && (e.event as { message: Message }).message.role === "tool",
    );
    expect(toolMessages).toHaveLength(2); // one per thread, never merged
    expect(new Set(toolMessages.map((e) => e.threadId)).size).toBe(2);
    for (const envelope of toolMessages) {
      const message = (envelope.event as { message: Message }).message;
      expect(message.content.filter((b) => b.type === "toolResult")).toHaveLength(count);
    }
  });
});
