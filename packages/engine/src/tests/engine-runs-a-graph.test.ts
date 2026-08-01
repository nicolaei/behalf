// B3.1's real proof, and the reason the package exists.
//
// `engine-is-ai-free.test.ts` (kept alongside this one) scans import
// specifiers. That is a cheap guard and a genuinely useful one, but it is a
// SOURCE-TEXT check: it cannot see a runtime coupling expressed as a string
// literal, and it already missed one — core's replay path hardcoded the event
// type `"message"`, ai's own vocabulary choice, in three places.
//
// This test is the honest version. It builds a runtime out of
// `@behalf-js/engine` and `@behalf-js/stores` only — no `ai` anywhere in the
// dependency graph, not as an import, not as a transitive package dep — and
// runs a real graph through it end to end: a seeded entry step, an edge
// function, a `waitFor` parked on a hand-rolled signal `Waitable` resumed from
// outside, and a finish. If any engine path still secretly needs ai to be
// registered, this fails.
//
// The flow deliberately uses no ai-shaped waitable. `userInput` is ai
// vocabulary by design (B3.0 settled the same question), so an engine-only
// flow parks on a signal instead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineGraph, driveFlow, outputs, runtime, seed } from "@behalf-js/engine";
import type { EventType, Waitable, WaitForResult } from "@behalf-js/engine";
import { memoryStore } from "@behalf-js/stores";

/** A park condition with no message vocabulary at all — matched purely off committed `signal` events. */
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

describe("a runtime built from the engine alone runs a real graph", () => {
  it("seeds, steps, routes through an edge function, parks, resumes, and finishes", async () => {
    const flow = defineGraph("engine-only", (flowBuilder) => {
      const double = flowBuilder.step(outputs((context) => (context.inputs[0] as number) * 2));
      const wait = flowBuilder.waitFor(pingSignal());
      const report = flowBuilder.step(
        outputs((context) => {
          const resumed = context.inputs[0] as WaitForResult<{ pong: string }>;
          return resumed.result.pong;
        }),
      );

      flowBuilder.entry(double);
      // An edge function: runs once at routing commit, and — per the engine's
      // own non-negotiable rule — emits rather than mutates, so replay
      // reconstructs its effect from the log instead of re-running it.
      double.then(wait, {
        run: (value, context) => {
          context.appendEvent({ to: `doubled-${String(value)}` }, "stateChange");
          return value;
        },
      });
      wait.then(report);
      report.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ store });

    seed(flow, 21, ready);
    const done = driveFlow(flow, ready);
    store.receive({ kind: "signal", name: "ping", payload: { pong: "hello" } });

    expect(await done).toBe("hello");

    // No ai vocabulary was invented on the engine's behalf: the log holds
    // engine event types only.
    const types = store
      .events()
      .filter((envelope) => envelope.form === "committed")
      .map((envelope) => envelope.type as EventType);
    expect(types).toContain("input");
    expect(types).toContain("stateChange");
    expect(types).toContain("signal");
    // The edge function really ran, and left its trace where an event-sourced
    // engine insists it belongs: in the log.
    const states = store
      .events()
      .filter((envelope) => envelope.form === "committed" && envelope.type === "stateChange")
      .map((envelope) => (envelope.event as { to: string }).to);
    expect(states).toContain("doubled-42");
    expect(types).not.toContain("message");
    expect(types).not.toContain("toolCall");
    expect(types).not.toContain("compaction");

    await ready.stop();
  });

  it("declares no dependency on @behalf-js/core", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@behalf-js/core");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("@behalf-js/core");
  });
});
