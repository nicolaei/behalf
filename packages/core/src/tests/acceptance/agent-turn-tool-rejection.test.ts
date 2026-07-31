import { describe, it, expect } from "vitest";
import { agentTurn, driveFlow, runtime, provide, tool } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Model, ModelPort, Profile, Tool } from "../../index.js";
import { assistantText, assistantToolCall, loggedEnvelopes } from "./support.js";

// The regression this test exists to prove fixed: a tool handler that REJECTS
// (e.g. `read` on a path that doesn't exist) used to stall the whole session
// forever. `startToolExecutor`'s dispatch loop only ever committed a
// `toolResult` on a resolved promise; a rejected one was caught and silently
// swallowed (`.catch(() => {})`, execution.ts), so the `waitFor(toolCall(id))`
// that only a matching `toolResult` event can resolve never did. That parked
// `forEach` branch's own `fold` join — a join that needs every branch to
// resolve — never completed, so `agentTurn` never finished, so `chatGraph`'s
// loop never got back to `waitForPrompt` to accept new user input. Discovered
// live in cockpit's "cockpit-2" project: a `read` call on a nonexistent path
// left the session accepting no further prompts, with a `toolCall` event and
// no matching `toolResult` ever landing in its envelope log.
//
// The fix: `executeToolCall` now catches a rejecting handler itself and
// commits `{ output: { error: message }, isError: true }` instead of letting
// the rejection propagate un-logged.
describe("agentTurn survives a rejecting tool handler", () => {
  const MODEL: Model = {
    identifier: "scripted",
    provider: "test",
    contextWindow: 1000,
    reasoning: [],
  };
  const failing = tool<Record<string, never>, unknown>(
    "failing",
    "A tool whose handler always rejects.",
  );

  it("driveFlow resolves (not hangs) and commits an isError toolResult for the rejected call", async () => {
    const tools: Tool[] = [failing];
    const profile: Profile = { model: MODEL, system: "agent", tools };

    let call = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: () => {
        call += 1;
        return Promise.resolve(
          call === 1 ? (assistantToolCall("failing", {}) as never) : assistantText("done"),
        );
      },
    };

    const store = memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: [provide(failing, () => Promise.reject(new Error("ENOENT: no such file")))],
      store,
    });

    const result = await driveFlow(agentTurn(profile), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "done" });
    expect(call).toBe(2); // the turn looped back to the model after the failed tool call resolved

    const envelopes = loggedEnvelopes(store);
    const toolResults = envelopes.filter((e) => e.type === "toolResult");
    expect(toolResults).toHaveLength(1);
    const resultEvent = toolResults[0]?.event as { output: unknown; isError?: boolean };
    expect(resultEvent.isError).toBe(true);
    expect(resultEvent.output).toEqual({ error: "ENOENT: no such file" });
  }, 5000); // tight timeout: a regression must fail fast by timing out, not hang the whole suite
});
