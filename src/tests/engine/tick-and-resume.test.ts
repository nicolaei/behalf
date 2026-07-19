import { describe, it, expect } from "vitest";
import { tick, tickUntilSuspended } from "../../engine/runtime.js";
import type { TickOutcome } from "../../engine/runtime.js";
import { defineGraph, runtime, adapters } from "../../index.js";
import type { Graph, Runtime, WaitForResult } from "../../index.js";
import { neverCalled, textOf } from "../acceptance/support.js";

// Needs tick() to advance a flow exactly one node, reconstructing position
// purely from runtime.store on every call — currently waitFor is driven by
// an internal setTimeout-polling loop inside one long-lived runFlow call,
// so there's nothing to "resume" yet. This is the prerequisite for genuine
// crash recovery ("the same graph replays deterministically").
describe("ticking a flow one node at a time and resuming it from the store alone", () => {
  function fixture(name: string): Graph {
    return defineGraph(name, (flow) => {
      const start = flow.step((context) => Promise.resolve(context.output("go")));
      const gate = flow.waitFor("follow-up");
      const finish = flow.step((context) =>
        Promise.resolve(context.output(`got: ${textOf(context.thread.messages.at(-1))}`)),
      );
      flow.entry(start);
      start.then(gate);
      gate.then(finish);
      finish.then(flow.finish);
    });
  }

  function followUp(text: string) {
    return {
      role: "user" as const,
      intent: "standard" as const,
      kind: "follow-up",
      content: [{ type: "text" as const, text }],
    };
  }

  it("advances one node per tick, then suspends at waitFor", async () => {
    const graph = fixture("tick-advances");
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const first = await tick(graph, ready); // runs `start`
    expect(first).toEqual({ status: "advanced" });

    const second = await tick(graph, ready); // reaches `gate`, nothing in the inbox
    expect(second).toEqual({ status: "suspended" });
  });

  it("resumes and finishes once a fresh tick sees the submitted message, using tickUntilSuspended", async () => {
    const graph = fixture("tick-resumes-same-runtime");
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const parked = await tickUntilSuspended(graph, ready); // start, then suspend at gate
    expect(parked).toEqual({ status: "suspended" });

    store.submit(followUp("approved"));

    // a brand new call, same runtime object, same store: proves position came
    // from the store, not from any state tick() carried in its own closures
    const finished = await tickUntilSuspended(graph, ready);
    expect(finished).toEqual({ status: "done", result: "got: approved" });
  });

  it("resumes correctly even with a brand new Runtime object per tick — only the store persists", async () => {
    const graph = fixture("tick-resumes-fresh-runtime");
    const store = adapters.stores.memoryStore();

    // every tick gets its own fresh runtime() call — the only thing carried
    // between them is the store itself, nothing cached on a shared Runtime
    async function freshTick(): Promise<TickOutcome> {
      const ready: Runtime = await runtime({ models: neverCalled, bindings: [], store });
      return tick(graph, ready);
    }

    const first = await freshTick(); // runs `start`
    expect(first).toEqual({ status: "advanced" });

    const second = await freshTick(); // reaches `gate`, nothing in the inbox
    expect(second).toEqual({ status: "suspended" });

    store.submit(followUp("approved"));

    const third = await freshTick(); // runs `finish`
    expect(third).toEqual({ status: "done", result: "got: approved" });
  });

  it("gives the waitFor's result as { ok: true }, matching runFlow, with the message already on the thread", async () => {
    const graph = defineGraph("tick-waitfor-ok", (flow) => {
      const start = flow.step((context) => Promise.resolve(context.output("go")));
      const gate = flow.waitFor("follow-up");
      const finish = flow.step((context) => {
        const result = context.inputs[0] as WaitForResult;
        return Promise.resolve(
          context.output({
            ok: result.ok,
            lastMessageText: textOf(context.thread.messages.at(-1)),
          }),
        );
      });
      flow.entry(start);
      start.then(gate);
      gate.then(finish);
      finish.then(flow.finish);
    });
    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await tickUntilSuspended(graph, ready); // suspends at gate
    store.submit(followUp("approved"));
    const result = await tickUntilSuspended(graph, ready);

    expect(result).toEqual({
      status: "done",
      result: { ok: true, lastMessageText: "approved" },
    });
  });
});
