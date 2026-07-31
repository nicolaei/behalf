import { describe, it, expect } from "vitest";
import { defineGraph, runtime, runFlow, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { EngineExtension } from "../../index.js";
import { neverCalled } from "./support.js";

// Test-only event type + extension — not shipped. Proves EngineExtension.reducers fold
// this extension's own events into its own per-scope state slot (ExecutionScope.state(name)),
// isolated from another extension's slot — even one registered on the very same scope,
// consuming the very same committed log.
declare module "../../session/event.js" {
  interface Event {
    note: { text: string };
  }
}

describe("EngineExtension.reducers fold events into the extension's own scope-state slot", () => {
  it("replay folds a custom event type into ctx.state(extension), independent of another extension's slot", async () => {
    const notes: EngineExtension = {
      name: "notes",
      stepContext(scope) {
        return {
          notesState: () => scope.state("notes"),
          bystanderState: () => scope.state("bystander"),
        };
      },
      reducers: {
        note: (state, envelope) => [
          ...(Array.isArray(state) ? state : []),
          (envelope.event as { text: string }).text,
        ],
      },
    };
    // Registered on the same scope, same log — but declares no reducers, so its own
    // slot must stay empty no matter what `notes` folds from the identical events.
    const bystander: EngineExtension = { name: "bystander" };

    const flow = defineGraph("reducers-custom-event-fold", (flowBuilder) => {
      const write = flowBuilder.step((context) => {
        context.appendEvent({ text: "first" }, "note");
        context.appendEvent({ text: "second" }, "note");
        const ctx = context as unknown as {
          notesState(): unknown;
          bystanderState(): unknown;
        };
        return Promise.resolve(
          context.output({ notes: ctx.notesState(), bystander: ctx.bystanderState() }),
        );
      });
      flowBuilder.entry(write);
      write.then(flowBuilder.finish);
    });

    const store = memoryStore();
    const ready = await runtime({
      models: neverCalled,
      bindings: [],
      store,
      extensions: [notes, bystander],
    });

    const result = await runFlow(flow, userText("go"), ready);

    expect(result).toEqual({ notes: ["first", "second"], bystander: undefined });
  });
});
