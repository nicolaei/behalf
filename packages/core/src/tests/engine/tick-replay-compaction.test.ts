import { describe, it, expect } from "vitest";
import { tick } from "../../runtime/runtime.js";
import type { TickOutcome, Runtime } from "../../runtime/runtime.js";
import { defineGraph, runtime, userInput, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, SessionStore } from "../../index.js";
import { neverCalled, textOf, assistantText } from "../acceptance/support.js";

// Phase 1 fixed the position/cursor half of the compact-replay bug: every
// step (including one that calls compact()) now logs a proper `output`
// event, so replay stops re-running it. This file isolates the OTHER half —
// thread-CONTENT correctness — deliberately without any position/cursor
// assertion: a from-scratch replay must derive the same `thread.messages` a
// live, continuous drive would have, which means replayPosition needs its
// own dispatch branch for "compaction" events, not just "output"/"message"/
// "signal".
describe("replay reconstructs thread.messages across a compaction, from the log alone", () => {
  function fixture(name: string): Graph {
    return defineGraph(name, (flow) => {
      const start = flow.step((context) => Promise.resolve(context.output("go")));
      const gate1 = flow.waitFor(userInput("first"));
      const gate2 = flow.waitFor(userInput("second"));
      const doCompact = flow.step(async (context) => {
        await context.compact({ summary: assistantText("summary"), keepLast: 1 });
        return context.output(true);
      });
      const read = flow.step(
        outputs((context) => context.thread.messages.map((message) => textOf(message))),
      );
      flow.entry(start);
      start.then(gate1);
      gate1.then(gate2);
      gate2.then(doCompact);
      doCompact.then(read);
      read.then(flow.finish);
    });
  }

  function followUp(kind: string, text: string) {
    return {
      kind: "message" as const,
      message: {
        role: "user" as const,
        intent: "standard" as const,
        kind,
        content: [{ type: "text" as const, text }],
      },
    };
  }

  it("derives messages = [summary, kept tail] after replaying a mid-log compaction", async () => {
    const graph = fixture("tick-replay-compacts");
    const store: SessionStore = memoryStore();

    // Every call below gets a BRAND NEW Runtime object, same store — the
    // exact technique that caught the original compact bug: nothing may
    // survive a tick() call except what's already committed to the log.
    async function freshTick(): Promise<TickOutcome> {
      const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
      return tick(graph, ready);
    }

    await freshTick(); // runs start, reports active at gate1
    await freshTick(); // peeks gate1, parks — nothing in the inbox yet

    store.receive(followUp("first", "first-text"));
    await freshTick(); // consumes "first", peeks gate2, parks

    store.receive(followUp("second", "second-text"));
    await freshTick(); // consumes "second", runs doCompact, reports active at read

    // The critical call: a fresh replay must fold the just-logged
    // "compaction" event into thread.messages BEFORE `read` runs, or `read`
    // sees the raw, uncompacted message list instead.
    const final = await freshTick();

    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      status: "done",
      // summary text, then only the kept tail (last 1 message: "second-text")
      // — NOT ["first-text", "second-text"], which is what an unfixed
      // replay (ignoring "compaction" events) would still report.
      result: ["summary", "second-text"],
    });
  });
});
