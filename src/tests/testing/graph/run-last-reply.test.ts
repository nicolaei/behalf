import { describe, it, expect } from "vitest";
import { defineGraph, runtime, adapters } from "../../../index.js";
import type { Profile } from "../../../index.js";
import { stepUntilBlocked } from "../../../testing/graph/index.js";
import { saidOn } from "../../../testing/eval/index.js";

// Bug report: foldRun hardcodes lastReply()/messages() to always return
// empty, even though a run drove a real assistant reply through the real
// engine. This is an acceptance test — real graph, real fake model, only the
// public graph/eval barrels — not a foldRun unit test.
describe("a run whose step called the model", () => {
  function respondGraph() {
    const profile: Profile = {
      model: adapters.models.fakePort.model,
      system: "test persona",
      tools: [],
    };
    return defineGraph("respond", (flow) => {
      const respond = flow.step(async (context) => {
        await context.modelCall(profile);
        return context.output("done");
      });
      flow.entry(respond);
      respond.then(flow.finish);
    });
  }

  it("run.lastReply() returns the model's actual reply", async () => {
    const ready = await runtime({
      models: () => adapters.models.fakePort,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(respondGraph(), ready);

    expect(run.lastReply()?.role).toBe("assistant");
    expect(run.lastReply()?.content).toContainEqual({ type: "text", text: "ok" });
  });

  it("saidOn scores 1 when the reply matches, via the public scorer", async () => {
    const ready = await runtime({
      models: () => adapters.models.fakePort,
      bindings: [],
      store: adapters.stores.memoryStore(),
    });

    const run = await stepUntilBlocked(respondGraph(), ready);

    expect(saidOn(undefined, /ok/i).score(run)).toBe(1);
  });
});
