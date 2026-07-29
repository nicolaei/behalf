import { describe, it, expect } from "vitest";
import {
  defineGraph,
  driveFlow,
  runtime,
  provide,
  tool,
  outputs,
  toolCall,
  userInput,
} from "../../index.js";
import type { SessionStore } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, textOf } from "./support.js";

/**
 * Wraps a store so `arrival` fires the first time `consume()` — the primitive
 * `tick()`'s own waitFor peek drains through — finds nothing. Simulates a
 * message landing in the exact gap between a failed peek and whatever happens
 * next, deterministically, instead of hoping JS's own microtask timing lands
 * there. Everything else passes straight through to `base`.
 */
function withArrivalDuringPeek(base: SessionStore, arrival: () => void): SessionStore {
  let injected = false;
  return {
    events: () => base.events(),
    inbox: () => base.inbox(),
    receive: (entry) => {
      base.receive(entry);
    },
    awaitReceive: () => base.awaitReceive(),
    consume: (matches) => {
      const result = base.consume(matches);
      if (result === undefined && !injected) {
        injected = true;
        arrival();
      }
      return result;
    },
    append: (event, meta) => {
      base.append(event, meta);
    },
    open: (meta) => base.open(meta),
    changes: () => base.changes(),
  };
}

// driveFlow wraps tickUntilSuspended with a real wait (store.awaitReceive())
// whenever every cursor is parked, instead of returning the instant nothing
// can advance right now. This is what lets a session keep going once an
// asynchronous tool call (resolved independently by the decoupled tool
// executor — see runtime/execution.ts's startToolExecutor) actually lands,
// and what lets a caller drive a long-lived session with no initial seed
// message at all.
describe("driveFlow", () => {
  it("parks at its own entry waitFor with no seed message, and resumes once one arrives", async () => {
    const flow = defineGraph("drive-flow-no-seed", (flowBuilder) => {
      const wait = flowBuilder.waitFor(userInput("go"));
      const echo = flowBuilder.step(outputs((context) => textOf(context.thread.messages.at(-1))));
      flowBuilder.entry(wait);
      wait.then(echo);
      echo.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = driveFlow(flow, ready);

    // Nothing was seeded — driveFlow must not resolve, or do anything at
    // all, before a message actually arrives. Sent synchronously, in the
    // same tick driveFlow was started in — the exact lost-wakeup window
    // (see the dedicated regression test below): this only resolves
    // because driveFlow subscribes to awaitReceive() BEFORE checking
    // tickUntilSuspended's outcome, not after.
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "go",
        content: [{ type: "text", text: "hello" }],
      },
    });

    expect(await done).toBe("hello");
  });

  it("waits through a REAL async tool-call delay and continues automatically (the regression case)", async () => {
    const slow = tool<Record<string, never>, { done: boolean }>(
      "slow",
      "A tool that resolves after a delay.",
    );

    const flow = defineGraph("drive-flow-tool-delay", (flowBuilder) => {
      const request = flowBuilder.step((context) => {
        context.appendEvent({ correlationId: "call-1", name: "slow", input: {} }, "toolCall");
        return Promise.resolve(context.output(undefined));
      });
      const wait = flowBuilder.waitFor(toolCall("call-1"));
      const after = flowBuilder.step(outputs((context) => context.inputs[0]));
      flowBuilder.entry(request);
      request.then(wait);
      wait.then(after);
      after.then(flowBuilder.finish);
    });

    const ready = await runtime({
      models: neverCalled,
      bindings: [
        provide(
          slow,
          () =>
            new Promise((resolve) => {
              // A genuine setTimeout, not a synchronously-resolving fake —
              // proves driveFlow actually waits through real async latency,
              // not just a microtask queue that happens to drain in time.
              setTimeout(() => {
                resolve({ done: true });
              }, 30);
            }),
        ),
      ],
      store: memoryStore(),
    });

    const result = await driveFlow(flow, ready);

    expect(result).toEqual({ ok: true, result: { done: true } });
  });

  it("continues across two sequential prompts in one driveFlow call", async () => {
    const responses: string[] = [];

    const flow = defineGraph("drive-flow-two-turns", (flowBuilder) => {
      const wait = flowBuilder.waitFor(userInput("prompt"));
      const respond = flowBuilder.step((context) => {
        responses.push(textOf(context.thread.messages.at(-1)));
        return Promise.resolve(context.output(undefined));
      });
      flowBuilder.entry(wait);
      wait.then(respond);
      respond.when(() => responses.length < 2, wait).otherwise(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = driveFlow(flow, ready);

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "prompt",
        content: [{ type: "text", text: "first" }],
      },
    });

    // The second prompt arrives only after the first turn has already been
    // processed and the flow has looped back to parking on the same
    // waitFor — proving driveFlow resumed on its own, with no second call.

    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "prompt",
        content: [{ type: "text", text: "second" }],
      },
    });

    await done;

    expect(responses).toEqual(["first", "second"]);
  });

  it("resolves with the right output for a flow that finishes, not just a forever-looping one", async () => {
    const flow = defineGraph("drive-flow-finishes", (flowBuilder) => {
      const respond = flowBuilder.step(outputs(() => "done"));
      flowBuilder.entry(respond);
      respond.then(flowBuilder.finish);
    });

    const ready = await runtime({ models: neverCalled, bindings: [], store: memoryStore() });

    const result = await driveFlow(flow, ready);

    expect(result).toBe("done");
  });

  it("never loses a wake that lands during tickUntilSuspended's own peek (subscribe-before-check regression)", async () => {
    const flow = defineGraph("drive-flow-race", (flowBuilder) => {
      const wait = flowBuilder.waitFor(userInput("go"));
      const echo = flowBuilder.step(outputs((context) => textOf(context.thread.messages.at(-1))));
      flowBuilder.entry(wait);
      wait.then(echo);
      echo.then(flowBuilder.finish);
    });

    const base = memoryStore();
    // Fires the instant tick()'s own waitFor peek reports "nothing yet" —
    // deterministically recreating the exact race: a receive() landing
    // between that failed peek and driveFlow's own awaitReceive() call.
    // A driveFlow that subscribes AFTER checking tickUntilSuspended's
    // outcome misses this wake entirely and hangs forever, since nothing
    // else ever calls receive()/append() again in this test; one that
    // subscribes BEFORE checking (the fix) catches it and resolves.
    const store = withArrivalDuringPeek(base, () => {
      base.receive({
        kind: "message",
        message: {
          role: "user",
          intent: "standard",
          kind: "go",
          content: [{ type: "text", text: "hello" }],
        },
      });
    });

    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const result = await driveFlow(flow, ready);

    expect(result).toBe("hello");
  });
});
