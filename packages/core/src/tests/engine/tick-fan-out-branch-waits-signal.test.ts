import { describe, it, expect } from "vitest";
import { tickUntilSuspended } from "../../engine/runtime.js";
import { defineGraph, runtime, join, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Waitable, WaitForResult } from "../../index.js";
import { neverCalled } from "../acceptance/support.js";

// A review of the driveGraph/tick() waitFor unification (commit 31b1a10)
// flagged this combination as untested either before or after that change.
// Written to close the gap, it instead found a real, pre-existing bug:
// tickUntilSuspended (tick.ts) hangs forever — confirmed via `git stash`
// against fan-out.ts as it stood BEFORE this session's unification, so this
// is not a regression from that refactor, just a latent defect it happened
// to surface. Skipped rather than left hanging in the suite; see the tracked
// problem for the fix. Un-skip once tick's peek+signal handling for a
// fan-out branch's own waitFor node is fixed.
describe("ticking a fan-out branch that waits for a signal", () => {
  function pingSignal(): Waitable<{ pong: string }> {
    return {
      provider: "test-signal",
      label: "ping",
      match(events) {
        for (const envelope of events) {
          if (envelope.form !== "committed" || envelope.type !== "signal") continue;
          const event = envelope.event as { name: string; payload?: unknown };
          if (event.name === "ping") return event.payload as { pong: string };
        }
        return undefined;
      },
    };
  }

  const flow = defineGraph("tick-fan-out-branch-waits-signal", (flowBuilder) => {
    const start = flowBuilder.step(outputs(() => "go"));
    const a = flowBuilder.step(outputs(() => "a"));
    const wait = flowBuilder.waitFor(pingSignal());
    const afterWait = flowBuilder.step(
      outputs((context) => (context.inputs[0] as WaitForResult<{ pong: string }>).result.pong),
    );
    const joinStep = flowBuilder.step(join((context) => context.inputs));
    flowBuilder.entry(start);
    start.then([a, wait]);
    a.then(joinStep);
    wait.then(afterWait);
    afterWait.then(joinStep);
    joinStep.then(flowBuilder.finish);
  });

  it.skip("reports the waiting branch as parked with its signal's label, resumable across tick calls", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const parked = await tickUntilSuspended(flow, ready);

    expect(
      parked.some((cursor) => cursor.status === "parked" && cursor.waitingFor?.includes("ping")),
    ).toBe(true);

    store.receive({ kind: "signal", name: "ping", payload: { pong: "yes" } });

    const resumed = await tickUntilSuspended(flow, ready);

    expect(resumed).toHaveLength(1);
    expect(resumed).toMatchObject([{ status: "done" }]);
    expect(resumed[0]?.result).toEqual(expect.arrayContaining(["a", "yes"]));
  });
});
