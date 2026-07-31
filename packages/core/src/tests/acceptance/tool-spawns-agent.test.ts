import { describe, it, expect } from "vitest";
import {
  ai,
  defineGraph,
  runtime,
  provide,
  tool,
  userText,
  localAgentSpawner,
} from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { AgentSpawner, Runtime, SessionStore } from "../../index.js";
import { neverCalled, textOf } from "./support.js";
import { runToCompletion } from "@behalf-js/testing";

// `ToolContext.runFlow` — a tool handler driving a sub-flow on the PARENT's own
// store — is replaced by `spawnAgent`, which creates a child *session* with its
// own log through an `AgentSpawner` port the host provides. Two properties earn
// the port its keep, and both are asserted here rather than assumed:
//
//   * spawning is idempotent per the tool call's own correlationId, so a tool
//     executor re-dispatching a pending call after a restart attaches to the
//     existing child instead of starting a second one;
//   * a child is durable, so a parent that lost its process mid-flight can
//     rebuild the spawner from the surviving child store and still observe the
//     result.
describe("a tool handler spawning a child agent", () => {
  /** A host-side registry of child stores, keyed the way a real one would be. Survives a simulated restart because the caller holds it, not the runtime. */
  function childStores(): {
    stores: Map<string, SessionStore>;
    spawner: () => AgentSpawner;
    created: () => number;
  } {
    const stores = new Map<string, SessionStore>();
    let created = 0;
    const createRuntime = (key: string): Promise<Runtime> => {
      let store = stores.get(key);
      if (!store) {
        created += 1;
        store = memoryStore();
        stores.set(key, store);
      }
      return runtime({ store, extensions: [ai({ models: neverCalled, bindings: [] })] });
    };
    return {
      stores,
      spawner: () => localAgentSpawner({ createRuntime }),
      created: () => created,
    };
  }

  const child = defineGraph("child", (flow) => {
    const step = flow.step((context) =>
      Promise.resolve(context.output(`answered: ${textOf(context.thread.messages.at(-1))}`)),
    );
    flow.entry(step);
    step.then(flow.finish);
  });

  const research = tool<{ question: string }, unknown>(
    "research",
    "Spawn a child agent to answer a question.",
  );

  const parent = defineGraph("parent", (flow) => {
    const ask = flow.step(async (context) =>
      context.output(await context.callTool(research, { question: "what is x" })),
    );
    flow.entry(ask);
    ask.then(flow.finish);
  });

  it("resolves with the child's finish result, and runs it on its own store", async () => {
    const host = childStores();
    const parentStore = memoryStore();
    const ready = await runtime({
      store: parentStore,
      extensions: [
        ai({
          models: neverCalled,
          bindings: [
            provide(research, async (input, context) => {
              const handle = context.spawnAgent(child, userText(input.question));
              return (await handle.result()).result;
            }),
          ],
          spawner: host.spawner(),
        }),
      ],
    });

    const result = await runToCompletion(parent, userText("go"), ready);

    expect(result).toBe("answered: what is x");
    // The child kept its own log: nothing it did leaked into the parent's.
    expect(host.stores.size).toBe(1);
    const childStore = [...host.stores.values()][0];
    expect(childStore?.events().length).toBeGreaterThan(0);
    const parentInputs = parentStore
      .events()
      .filter((envelope) => envelope.form === "committed" && envelope.type === "input");
    expect(parentInputs).toHaveLength(1);
  });

  it("spawns once per correlationId, however many times the same call is dispatched", async () => {
    const host = childStores();
    const spawner = host.spawner();
    let runs = 0;
    const counted = defineGraph("counted-child", (flow) => {
      const step = flow.step((context) => {
        runs += 1;
        return Promise.resolve(context.output("done"));
      });
      flow.entry(step);
      step.then(flow.finish);
    });

    const first = spawner.spawn("call-1", counted, userText("go"));
    const second = spawner.spawn("call-1", counted, userText("go"));

    expect(second.id).toBe(first.id);
    expect(await first.result()).toEqual({ result: "done", succeeded: true });
    expect(await second.result()).toEqual({ result: "done", succeeded: true });
    expect(host.created()).toBe(1);
    expect(runs).toBe(1);
  });

  it("re-attaches to a child that outlived the process that spawned it", async () => {
    const host = childStores();

    // Before the restart: spawn and let the child finish, then throw away the
    // spawner and every runtime it built — everything except the store.
    const before = host.spawner();
    const handle = before.spawn("call-1", child, userText("what is x"));
    await handle.result();

    // After: a brand-new spawner over the same surviving stores. Re-attaching
    // must observe the finished child rather than start a second one.
    const after = host.spawner();
    const reattached = after.spawn("call-1", child, userText("what is x"));

    expect(reattached.id).toBe(handle.id);
    expect(await reattached.result()).toEqual({
      result: "answered: what is x",
      succeeded: true,
    });
    expect(host.created()).toBe(1);
  });
});
