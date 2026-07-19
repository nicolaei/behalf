import { describe, it, expect } from "vitest";
import {
  defineGraph,
  runFlow,
  runtime,
  userText,
  adapters,
  outputs,
  tool,
  provide,
} from "../../index.js";
import { storeOnlyRuntime, neverCalled, loggedEventTypes } from "./support.js";

// Every scenario here needs a fan-out branch's StepContext to have the same
// capabilities as the main-loop's — currently callTool/compact/invalidate are
// notImplemented stubs inside runBranch. Written now so the shape is pinned
// down before that slice starts.
describe.skip("a fan-out branch step has full StepContext capabilities", () => {
  it("can call a tool from inside a branch, same as a main-path step", async () => {
    const search = tool<{ query: string }, { hits: string[] }>("search", "Search the web.");
    const graph = defineGraph("branch-calls-tool", (flow) => {
      const start = flow.step(outputs(() => "go"));
      const branch = flow.step(async (context) =>
        context.output(await context.callTool(search, { query: "behalf" })),
      );
      const join = flow.step(outputs((context) => context.inputs));

      flow.entry(start);
      start.then([branch]).join(join);
      join.then(flow.finish);
    });

    const ready = await runtime({
      models: neverCalled,
      bindings: [provide(search, (input) => Promise.resolve({ hits: [input.query] }))],
      store: adapters.stores.memoryStore(),
    });

    const result = await runFlow(graph, userText("go"), ready);

    expect(result).toEqual([{ hits: ["behalf"] }]);
  });

  it("can invalidate a node from inside a branch, rerunning it before the join proceeds", async () => {
    let attempts = 0;
    const graph = defineGraph("branch-invalidates", (flow) => {
      const start = flow.step(outputs(() => "go"));
      const target = flow.step(
        outputs(() => {
          attempts += 1;
          return attempts;
        }),
      );
      const branch = flow.step((context) =>
        Promise.resolve(
          context.inputs[0] === 1
            ? context.invalidate(target.id, { threadAction: "same" })
            : context.output("done"),
        ),
      );
      const join = flow.step(outputs((context) => context.inputs));

      flow.entry(start);
      start.then(target);
      target.then([branch]).join(join);
      join.then(flow.finish);
    });

    await runFlow(graph, userText("go"), await storeOnlyRuntime());

    expect(attempts).toBe(2);
  });

  it("can compact its thread's messages from inside a branch, logging a compaction event", async () => {
    const graph = defineGraph("branch-compacts", (flow) => {
      const start = flow.step(outputs(() => "go"));
      const branch = flow.step((context) =>
        context.compact(() =>
          Promise.resolve([{ role: "system", content: [{ type: "text", text: "summary" }] }]),
        ),
      );
      const join = flow.step(outputs((context) => context.inputs.length));

      flow.entry(start);
      start.then([branch]).join(join);
      join.then(flow.finish);
    });

    const store = adapters.stores.memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    await runFlow(graph, userText("go"), ready);

    // then the branch's compaction is logged, same as a main-path step's would be
    expect(loggedEventTypes(store)).toContain("compaction");
  });
});
