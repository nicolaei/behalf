import { describe, it, expect } from "vitest";
import { agentTurn, driveFlow, runtime, provide, tool } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Message, Model, ModelPort, Profile, Tool } from "../../index.js";
import { assistantText, assistantToolCall, loggedEnvelopes } from "./support.js";

// The regression this test exists to prove fixed: an agent whose tool call
// resolves after a REAL async delay (not a same-tick Promise) used to stop
// forever after that one tool call — the original bug, discovered live in a
// cockpit container. Phases 1-3 (commits a6172ad, 45b4891, 407c44f) fixed
// half of it (a step's completion always recognizable on replay, plus
// dedicated replay dispatch for "compaction"/"invalidation" events); the
// other half — a bare "message" event (modelCall's own reply, `fold`'s
// combined tool-result message) never surviving a fresh replay once the
// position moves past it — is the tick.ts applyMessageEvent fix in this same
// commit (regression-tested directly in tick-replay-message-fold.test.ts).
// This test exercises the whole stack those fixes are for, together: a real
// `agentTurn(profile)`, a real `driveFlow`, and a tool handler that only
// resolves after a genuine `setTimeout`.
//
// `driveFlow` needs a flow whose entry can run with no seed — `agentTurn`'s
// own entry (`respond`, an immediate modelCall) qualifies: the scripted
// ModelPort doesn't care that `context.thread.messages` starts empty, and
// the tool call's own `waitFor(toolCall(id))` is what naturally parks the
// flow through the real async delay, no outer wrapping required.
describe("agentTurn + driveFlow survive a real async tool-call delay", () => {
  const MODEL: Model = { identifier: "scripted", provider: "test", contextWindow: 1000, reasoning: [] };
  const slow = tool<Record<string, never>, { done: boolean }>(
    "slow",
    "A tool that resolves after a real delay.",
  );

  it("driveFlow resolves (not hangs), calling the model exactly twice, with no duplicate compaction/message events", async () => {
    const tools: Tool[] = [slow];
    const profile: Profile = { model: MODEL, system: "agent", tools };

    let call = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: () => {
        call += 1;
        return Promise.resolve(call === 1 ? (assistantToolCall("slow", {}) as never) : assistantText("done"));
      },
    };

    const store = memoryStore();
    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(
          slow,
          () =>
            new Promise((resolve) => {
              // A genuine setTimeout, not a synchronously-resolving fake — this is
              // the exact shape of delay that used to hang driveFlow forever: the
              // tool executor resolves independently of whatever step requested it,
              // and only driveFlow's own awaitReceive()-driven retry loop notices.
              setTimeout(() => {
                resolve({ done: true });
              }, 150);
            }),
        ),
      ],
      store,
    });

    const result = await driveFlow(agentTurn(profile), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "done" });
    expect(call).toBe(2); // model called once per turn — no redundant replay re-calls

    const envelopes = loggedEnvelopes(store);
    const compactionEvents = envelopes.filter((e) => e.type === "compaction");
    expect(compactionEvents).toHaveLength(0); // thread is tiny — nowhere near maybeCompact's budget

    const toolResultMessages = envelopes.filter(
      (e) => e.type === "message" && (e.event as { message: Message }).message.role === "tool",
    );
    expect(toolResultMessages).toHaveLength(1); // one combined message for the one tool-call round, not one per replay pass
  }, 5000); // tight timeout: a regression must fail fast by timing out, not hang the whole suite
});
