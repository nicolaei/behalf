import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { defineGraph, runFlow, runtime, provide, tool, userText, adapters } from "../../index.js";
import type {
  AssistantMessage,
  Message,
  ModelCallResult,
  ModelPort,
  Profile,
} from "../../index.js";
import { toAnthropicRequest } from "../../adapters/models/anthropic.js";
import { assistantToolCall, assistantToolCalls, assistantText } from "./support.js";

// Reproduces a real, observed bug: examples/simple-chat's chat graph loops a
// model step straight back to itself once it sees `usedTools` — the same
// shape as this file's `agentTurn` below — with no explicit step that waits
// for the tool results and folds them into the thread before the next
// modelCall. The assistant's tool_use block is folded into the thread by
// runModelCall itself, but its tool_result never is (executeToolCall commits
// it to the log, but never to any thread — see its own doc comment). The
// next request built from that thread carries a tool_use with no
// corresponding tool_result, which is exactly the 400 Anthropic returned:
// "tool_use ids were found without tool_result blocks immediately after".
describe("a model step that loops back to itself after a tool call", () => {
  // Mirrors examples/simple-chat's chat.ts `agentTurn` graph exactly: one
  // step, looping to itself while `usedTools`, otherwise finishing.
  function agentTurnGraph(profile: Profile) {
    return defineGraph("agent-turn", (flow) => {
      const respond = flow.step(async (context) =>
        context.output(await context.modelCall(profile)),
      );
      flow.entry(respond);
      respond
        .when((result) => !(result as ModelCallResult).usedTools, flow.finish)
        .otherwise(respond);
    });
  }

  function scriptedPort(replies: AssistantMessage[]): {
    port: ModelPort;
    capturedMessages: Message[][];
  } {
    const capturedMessages: Message[][] = [];
    let call = 0;
    const port: ModelPort = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      respond: (_profile, messages) => {
        capturedMessages.push(messages);
        const reply = replies[call] ?? replies.at(-1)!;
        call += 1;
        return Promise.resolve(reply);
      },
    };
    return { port, capturedMessages };
  }

  /** Every tool_use id in an Anthropic assistant message with no matching tool_result in the very next message. */
  function orphanedToolUseIds(messages: Anthropic.MessageParam[]): string[] {
    const orphans: string[] = [];
    messages.forEach((message, index) => {
      if (message.role !== "assistant" || typeof message.content === "string") return;
      const toolUseIds = message.content
        .filter((block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use")
        .map((block) => block.id);
      if (toolUseIds.length === 0) return;

      const next = messages[index + 1];
      const resultIds = new Set(
        next && next.role === "user" && typeof next.content !== "string"
          ? next.content
              .filter(
                (block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
              )
              .map((block) => block.tool_use_id)
          : [],
      );
      for (const id of toolUseIds) if (!resultIds.has(id)) orphans.push(id);
    });
    return orphans;
  }

  it("pairs a single tool call's tool_use with a tool_result before the next model request", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const profile: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      system: "agent",
      tools: [search],
    };

    const { port, capturedMessages } = scriptedPort([
      assistantToolCall("search", { query: "x" }),
      assistantText("done"),
    ]);

    const ready = await runtime({
      models: () => port,
      bindings: [provide(search, () => Promise.resolve({ hits: ["a"] }))],
      store: adapters.stores.memoryStore(),
    });

    await runFlow(agentTurnGraph(profile), userText("find x"), ready);

    // The second call is the one that must see the first call's tool_use
    // paired with its tool_result.
    const secondRequestMessages = capturedMessages[1]!;
    const request = toAnthropicRequest(profile, secondRequestMessages);

    expect(orphanedToolUseIds(request.messages)).toEqual([]);
  });

  it("pairs two simultaneous tool calls' tool_use blocks with their tool_results before the next model request", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const weather = tool<{ city: string }, { forecast: string }>("weather", "Get the weather.");
    const profile: Profile = {
      model: { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] },
      system: "agent",
      tools: [search, weather],
    };

    const { port, capturedMessages } = scriptedPort([
      assistantToolCalls([
        { name: "search", input: { query: "x" } },
        { name: "weather", input: { city: "Oslo" } },
      ]),
      assistantText("done"),
    ]);

    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(search, () => Promise.resolve({ hits: ["a"] })),
        provide(weather, () => Promise.resolve({ forecast: "sunny" })),
      ],
      store: adapters.stores.memoryStore(),
    });

    await runFlow(agentTurnGraph(profile), userText("find x and check weather"), ready);

    const secondRequestMessages = capturedMessages[1]!;
    const request = toAnthropicRequest(profile, secondRequestMessages);

    expect(orphanedToolUseIds(request.messages)).toEqual([]);
  });
});
