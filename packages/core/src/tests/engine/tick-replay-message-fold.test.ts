import { describe, it, expect } from "vitest";
import { tick, seed } from "../../runtime/runtime.js";
import type { TickOutcome, Runtime } from "../../runtime/runtime.js";
import { defineGraph, runtime, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, SessionStore } from "../../index.js";
import { neverCalled, textOf, assistantText } from "../acceptance/support.js";

// applyMessageEvent (tick.ts's replayPosition dispatch for a committed
// "message" event) only ever folds it into state.thread when the CURRENT
// replay position is a `waitFor` or `use` node consuming it — any other node
// is "skipped, since replay isn't tracking it" (see its own doc comment).
// That's correct for POSITION tracking (nothing else needs to move a level),
// but it silently drops the message's CONTENT too — so a bare `"message"`
// event appended by an ordinary step (e.g. context.appendEvent, or
// modelCall's own reply) never survives a fresh replay once the position has
// moved past it. tick()'s own one-step-per-call budget means `driveFlow`
// (which loops tick() until settled) does a FRESH replayPosition() on every
// single call — so any driveFlow-driven session needing 2+ tick() calls (any
// real async gap: a delayed tool call, for instance) loses that content.
// Deliberately no forEach/agentTurn/compaction here — this reproduces with
// nothing but a plain step that logs a message directly, isolating the exact
// gap from everything else already fixed in Phases 1-3.
describe("replay folds a bare message event's content, not just its position", () => {
  function fixture(name: string): Graph {
    return defineGraph(name, (flow) => {
      const announce = flow.step((context) => {
        context.appendEvent({ message: assistantText("done") }, "message");
        return Promise.resolve(context.output(true));
      });
      const read = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
      flow.entry(announce);
      announce.then(read);
      read.then(flow.finish);
    });
  }

  it("a later step still sees the message content after a fresh replay lands on it", async () => {
    const graph = fixture("tick-replay-message-fold");
    const store: SessionStore = memoryStore();

    // Every call below gets a BRAND NEW Runtime object, same store — the
    // exact technique that caught the original compact bug: nothing may
    // survive a tick() call except what's already committed to the log.
    // tick()'s own one-step-per-call budget means no waitFor is needed to
    // force a pause between steps: `announce` and `read` each land in their
    // own call.
    async function freshTick(): Promise<TickOutcome> {
      const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
      return tick(graph, ready);
    }

    seed(graph, undefined, await runtime({ models: neverCalled, bindings: [], store }));

    await freshTick(); // runs announce: logs the message, reports active at read

    // The critical call: a fresh replay must fold the just-logged "message"
    // event's content into state.thread before `read` runs, even though
    // `announce` (the node that logged it) is an ordinary step, not a
    // waitFor/use node replay already knows to fold messages for.
    const final = await freshTick();

    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ status: "done", result: "done" });
  });
});
