import { describe, it, expect } from "vitest";
import { tick, tickUntilSuspended } from "../../engine/runtime.js";
import type { TickOutcome, Runtime } from "../../engine/runtime.js";
import { defineGraph, runtime, adapters, outputs } from "../../index.js";
import type { Graph, Waitable, WaitForResult } from "../../index.js";
import { neverCalled } from "../acceptance/support.js";

// tick()'s non-blocking waitFor path and its replay reconstruction only know
// how to resolve a Waitable back to a message kind (Story 2 deliberately left
// this untouched). Written now so the contract is pinned down before Story
// 3's implementation starts: a signal-based Waitable must suspend/resume
// through tick() exactly like a userInput-based one already does, surviving
// a brand new Runtime object between calls — only the store persists.
describe("a signal-based wait survives a restart via tick()", () => {
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

  function fixture(name: string): Graph {
    return defineGraph(name, (flow) => {
      const start = flow.step((context) => Promise.resolve(context.output("go")));
      const gate = flow.waitFor(pingSignal());
      const finish = flow.step(
        outputs((context) => (context.inputs[0] as WaitForResult<{ pong: string }>).result.pong),
      );
      flow.entry(start);
      start.then(gate);
      gate.then(finish);
      finish.then(flow.finish);
    });
  }

  it("suspends at the signal-based waitFor, reporting its label as waitingFor", async () => {
    const graph = fixture("tick-signal-suspends");
    const store = adapters.stores.memoryStore();

    async function freshRuntime(): Promise<Runtime> {
      return runtime({ models: neverCalled, bindings: [], store });
    }

    const first = await tick(graph, await freshRuntime()); // runs `start`
    expect(first).toHaveLength(1);
    expect(first).toMatchObject([{ status: "active" }]);

    const second = await tick(graph, await freshRuntime()); // reaches `gate`, no signal yet
    expect(second).toHaveLength(1);
    expect(second).toMatchObject([{ status: "parked", waitingFor: ["ping"] }]);
  });

  it("resumes correctly with a brand new Runtime object per tick, once the signal arrives", async () => {
    const graph = fixture("tick-signal-resumes-fresh-runtime");
    const store = adapters.stores.memoryStore();

    async function freshTick(): Promise<TickOutcome> {
      const ready = await runtime({ models: neverCalled, bindings: [], store });
      return tick(graph, ready);
    }

    await freshTick(); // runs `start`
    const parked = await freshTick(); // reaches `gate`, no signal yet
    expect(parked).toMatchObject([{ status: "parked", waitingFor: ["ping"] }]);

    store.receive({ kind: "signal", name: "ping", payload: { pong: "hello" } });

    const finished = await freshTick(); // runs `finish`
    expect(finished).toMatchObject([{ status: "done", result: "hello" }]);
  });

  it("resumes via tickUntilSuspended across a fresh Runtime, same as a userInput-based wait", async () => {
    const graph = fixture("tick-signal-tickuntilsuspended");
    const store = adapters.stores.memoryStore();

    async function freshRuntime(): Promise<Runtime> {
      return runtime({ models: neverCalled, bindings: [], store });
    }

    const parked = await tickUntilSuspended(graph, await freshRuntime());
    expect(parked).toMatchObject([{ status: "parked", waitingFor: ["ping"] }]);

    store.receive({ kind: "signal", name: "ping", payload: { pong: "world" } });

    const finished = await tickUntilSuspended(graph, await freshRuntime());
    expect(finished).toMatchObject([{ status: "done", result: "world" }]);
  });
});
