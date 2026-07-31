import { describe, it, expect } from "vitest";
import { ai, agentTurn, runtime, provide, tool, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Message, Model, ModelPort, Profile, Tool } from "../../index.js";
import {
  assistantToolCall,
  assistantToolCalls,
  assistantText,
  loggedEnvelopes,
  orphanedToolCallIds,
  at,
} from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

// agentTurn is the library's own reusable "run a model, wait for every tool
// call it made, fold their results into one combined message, loop" graph —
// the generalized, exported version of agent-loop.test.ts's hand-rolled
// forEach + waitFor(toolCall(id)) + compact pattern. examples/simple-chat's
// chat.ts uses this instead of hand-rolling its own (buggy) loop.
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

describe.each(CALL_COUNTS)("agentTurn, %i simultaneous tool call(s)", (count) => {
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
      store: memoryStore(),
      extensions: [
        ai({
          models: () => port,
          bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
        }),
      ],
    });

    const result = await runToCompletion(agentTurn(profile), userText("go"), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "done" });
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
    const store = memoryStore();
    const ready = await runtime({
      store,
      extensions: [
        ai({
          models: () => port,
          bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
        }),
      ],
    });

    await runToCompletion(agentTurn(profile), userText("go"), ready);

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

  it("keeps each concurrent agent's collected results in its own session, even when correlationIds collide", async () => {
    const tools = toolsFor(count);
    const scriptFor = (): ModelPort["respond"] => {
      let call = 0;
      return () => {
        call += 1;
        return Promise.resolve(call === 1 ? (firstReply(tools) as never) : assistantText("done"));
      };
    };
    const profileA: Profile = { model: MODEL, system: "agent-A", tools };
    const profileB: Profile = { model: MODEL, system: "agent-B", tools };

    // Two concurrent agents are two SESSIONS, each with its own store — the
    // model `spawnAgent` gives a spawned child (see the AgentSpawner port).
    // Sharing one log between two independently-driven agents isn't a
    // supported shape any more: `tick()` reconstructs position from the whole
    // log, so two runs on one store would read each other's events as their
    // own. What this case actually protects is that colliding correlationIds
    // across concurrent agents never merge their tool results — which the
    // per-session store enforces structurally.
    async function runAgent(profile: Profile): Promise<{
      result: unknown;
      store: ReturnType<typeof memoryStore>;
    }> {
      const respond = scriptFor();
      const store = memoryStore();
      const ready = await runtime({
        store,
        extensions: [
          ai({
            models: () => ({ model: MODEL, respond }),
            bindings: tools.map((t) => provide(t, () => Promise.resolve({ ok: true }))),
          }),
        ],
      });
      const result = await runToCompletion(agentTurn(profile), userText(profile.system), ready);
      return { result, store };
    }

    const [runA, runB] = await Promise.all([runAgent(profileA), runAgent(profileB)]);

    expect([runA.result, runB.result]).toEqual([
      { finishedBy: "finalMessage", text: "done" },
      { finishedBy: "finalMessage", text: "done" },
    ]);

    for (const run of [runA, runB]) {
      const toolMessages = loggedEnvelopes(run.store).filter(
        (e) => e.type === "message" && (e.event as { message: Message }).message.role === "tool",
      );
      expect(toolMessages).toHaveLength(1); // one per session, never merged
      const message = (at(toolMessages, 0).event as { message: Message }).message;
      expect(message.content.filter((b) => b.type === "toolResult")).toHaveLength(count);
    }
  });
});
