import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, runtime, userText, outputs, userInput } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Graph, Message, WaitForResult } from "../../index.js";
import { neverCalled, textOf } from "./support.js";

// Flow.forEach throws notImplemented and tick()/drive.ts have no support for
// the forEach NodeKind yet. Written now so the shape is pinned before
// implementation starts: forEach computes its items from a prior step's
// output, builds one branch Graph per item via a factory function (not
// authored statically), runs it, and folds every branch's own result back
// into an array as the forEach node's own single output. Story 2 is
// deliberately the smallest case — exactly one dynamically-produced item,
// whose branch is a single waitFor node — to isolate "does dynamic branch
// construction and execution work at all" from every other concern.
describe("forEach runs a single dynamically-produced branch, end-to-end", () => {
  function branchFor(item: string): Graph {
    return defineGraph(`forEach-branch-${item}`, (flow) => {
      const wait = flow.waitFor(userInput("resume"));
      const finish = flow.step(
        outputs((context) => {
          const result = context.inputs[0] as WaitForResult<Message>;
          return `${item}:${textOf(result.result)}`;
        }),
      );
      flow.entry(wait);
      wait.then(finish);
      finish.then(flow.finish);
    });
  }

  const flow = defineGraph("forEach-single-branch", (flowBuilder) => {
    const produce = flowBuilder.step(outputs(() => ["only"]));
    const each = flowBuilder.forEach((output) => output as string[], branchFor);
    const fold = flowBuilder.step(outputs((context) => context.inputs[0]));
    flowBuilder.entry(produce);
    produce.then(each);
    each.then(fold);
    fold.then(flowBuilder.finish);
  });

  it("parks on the one dynamically-produced branch and folds its result", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    const done = runFlow(flow, userText("go"), ready);
    store.receive({
      kind: "message",
      message: {
        role: "user",
        intent: "standard",
        kind: "resume",
        content: [{ type: "text", text: "signal" }],
      },
    });

    expect(await done).toEqual(["only:signal"]);
  });
});
