import { describe, it, expect } from "vitest";
import { agentTurn, driveFlow, runtime, provide, tool } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { AssistantMessage, Message, Model, ModelPort, Profile, Tool } from "../../index.js";
import { assistantText, orphanedToolCallIds } from "./support.js";

// Root-cause regression for the live "unexpected tool_use_id" 400 from
// Anthropic: reported symptom was 2 tool calls in one turn, then — in a
// LATER turn — 2 more tool calls; the second turn's own model call then
// failed because its assembled message history spliced in a stale
// tool-result message from the FIRST turn instead of the second turn's own.
//
// Root cause (traced against the real behalf-runner SQLite log + this
// package's tick.ts/foreach.ts): agentTurn's own graph loops back to its
// "respond" step and re-enters the SAME forEach node ("each") every turn
// that used tools. `driveFlow` drives every turn through `tick()`, whose
// forEach handling (`advanceTickForEachNode` -> `buildForEachGroup` ->
// `forEachBranchThreadId`) derives each branch's thread id from ONLY the
// forEach node's own (stable, loop-wide) id and the item's index — with no
// notion of which pass through the loop this is. A second turn's branch 0
// gets the IDENTICAL thread id as the first turn's branch 0, so
// `replayForEachBranch`'s reconstruction (which scans the committed log for
// events tagged with that thread id) walks straight into the FIRST turn's
// already-completed branch and reports it "done" with the first turn's own
// stale output — never running the second turn's own tool wait at all.
//
// This exercises the exact stack that exposed it live: a real `agentTurn`,
// a real `driveFlow` (which drives every turn via `tick()`, not the
// separate `runFlow`/`driveGraph` path — the two-tool-calls-then-later-
// two-more shape only reaches the buggy `tick.ts` forEach machinery through
// `driveFlow`), and real tool bindings that resolve for real.
function assistantToolCallsWithIds(
  calls: { correlationId: string; name: string; input: unknown }[],
): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: calls.map((call) => ({
      type: "toolCall" as const,
      correlationId: call.correlationId,
      name: call.name,
      input: call.input,
    })),
    usage: { input: 1, output: 1 },
  };
}

describe("agentTurn + driveFlow: two separate tool-calling turns in one thread", () => {
  it("the SECOND turn's own model call sees every tool call paired with its own result — not the first turn's", async () => {
    const MODEL: Model = {
      identifier: "scripted",
      provider: "test",
      contextWindow: 1000,
      reasoning: [],
    };
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const weather = tool<{ city: string }, { forecast: string }>("weather", "Get the weather.");
    const tools: Tool[] = [search, weather];
    const profile: Profile = { model: MODEL, system: "agent", tools };

    const capturedMessages: Message[][] = [];
    let call = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: (_profile, messages) => {
        capturedMessages.push(messages);
        call += 1;
        if (call === 1) {
          // Turn 1: two tool calls.
          return Promise.resolve(
            assistantToolCallsWithIds([
              { correlationId: "turn1-a", name: "search", input: { query: "x" } },
              { correlationId: "turn1-b", name: "weather", input: { city: "Oslo" } },
            ]) as never,
          );
        }
        if (call === 2) {
          // Turn 2 (a LATER, separate turn — agentTurn's own loop, no new
          // user message in between): two MORE tool calls, fresh
          // correlationIds, exactly the reported live shape.
          return Promise.resolve(
            assistantToolCallsWithIds([
              { correlationId: "turn2-a", name: "search", input: { query: "y" } },
              { correlationId: "turn2-b", name: "weather", input: { city: "Bergen" } },
            ]) as never,
          );
        }
        return Promise.resolve(assistantText("done"));
      },
    };

    const store = memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(search, () => Promise.resolve({ hits: ["a"] })),
        provide(weather, () => Promise.resolve({ forecast: "sunny" })),
      ],
      store,
    });

    const result = await driveFlow(agentTurn(profile), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "done" });
    expect(call).toBe(3); // turn 1, turn 2, then the final no-tools reply

    // The THIRD model call (index 2) is the one that saw turn 2's own fold
    // applied to the thread. Anthropic's own invariant: every tool_use
    // (toolCall) block must be immediately followed by a message carrying
    // its own tool_result (toolResult) — never a different turn's.
    const messagesForThirdCall = capturedMessages[2];
    expect(messagesForThirdCall).toBeDefined();
    expect(orphanedToolCallIds(messagesForThirdCall ?? [])).toEqual([]);

    // Stronger, positive assertion: turn 2's own tool message must carry
    // turn 2's own correlationIds — not turn 1's stale ones.
    const toolMessages = (messagesForThirdCall ?? []).filter((m) => m.role === "tool");
    const lastToolMessage = toolMessages.at(-1);
    const resultIds = (lastToolMessage?.content ?? [])
      .filter((b): b is Extract<typeof b, { type: "toolResult" }> => b.type === "toolResult")
      .map((b) => b.correlationId);
    expect(resultIds.sort()).toEqual(["turn2-a", "turn2-b"]);
  });
});
