import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  userText,
  adapters,
  outputs,
  userInput,
} from "../../index.js";
import type { Graph, Message, WaitForResult } from "../../index.js";
import { neverCalled, textOf } from "./support.js";

// Story 2 proved forEach works for exactly one item whose branch is a bare
// waitFor node. This story generalizes both axes at once: (1) a dynamic
// *number* of branches — 1, 2, and 5 — and (2) a branch that's a real
// multi-node graph (step -> waitFor -> use), not just a single wait node.
// Proves forEach branches can be plain steps, waits, and use-composed
// subgraphs, and that folding doesn't depend on the order branches resolve
// in (each case below resolves its branches in reverse item order).
describe.skip("forEach runs N branches, each a multi-node graph (step -> waitFor -> use)", () => {
  // A small reusable subgraph, shared by every branch's `use` node — proves
  // `use` composes correctly inside a dynamically-instantiated forEach branch.
  const sharedSubgraph: Graph = defineGraph("forEach-shared-subgraph", (flow) => {
    const echo = flow.step(
      outputs((context) => textOf(context.thread.messages.at(-1)).toUpperCase()),
    );
    flow.entry(echo);
    echo.then(flow.finish);
  });

  function branchFor(item: string): Graph {
    return defineGraph(`forEach-branch-${item}`, (flow) => {
      const transform = flow.step(outputs(() => `${item}-prepped`));
      const wait = flow.waitFor(userInput(`resume-${item}`));
      const useShared = flow.use(sharedSubgraph);
      const finish = flow.step(outputs((context) => `${item}:${String(context.inputs[0])}`));
      flow.entry(transform);
      transform.then(wait);
      wait.then(useShared, {
        prompt: (value) => userText(textOf((value as WaitForResult<Message>).result)),
      });
      useShared.then(finish);
      finish.then(flow.finish);
    });
  }

  function buildFlow(items: string[]): Graph {
    return defineGraph(`forEach-${String(items.length)}-branches`, (flow) => {
      const produce = flow.step(outputs(() => items));
      const each = flow.forEach((output) => output as string[], branchFor);
      const fold = flow.step(outputs((context) => context.inputs[0]));
      flow.entry(produce);
      produce.then(each);
      each.then(fold);
      fold.then(flow.finish);
    });
  }

  describe.each([1, 2, 5])("with %i branch(es)", (count) => {
    const items = Array.from({ length: count }, (_, i) => `item${String(i)}`);
    const flow = buildFlow(items);

    it("resolves every branch regardless of order and folds results in item order", async () => {
      const store = adapters.stores.memoryStore();
      const ready = await runtime({ models: neverCalled, bindings: [], store });

      const done = runFlow(flow, userText("go"), ready);

      // Resolve in reverse item order — proves folding isn't dependent on
      // resolution order.
      for (const item of [...items].reverse()) {
        store.receive({
          kind: "message",
          message: {
            role: "user",
            intent: "standard",
            kind: `resume-${item}`,
            content: [{ type: "text", text: `signal-${item}` }],
          },
        });
      }

      const expected = items.map((item) => `${item}:${`signal-${item}`.toUpperCase()}`);
      expect(await done).toEqual(expected);
    });
  });
});
