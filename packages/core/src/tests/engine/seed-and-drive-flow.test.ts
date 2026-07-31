import { describe, it, expect } from "vitest";
import { seed, driveFlow, runtime } from "../../runtime/runtime.js";
import { defineGraph, userText, outputs } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { neverCalled, textOf } from "../acceptance/support.js";

// B2.4 — seed() + the `input` event become the durable "here is your
// starting value" fact `tick`/`driveFlow` replay from, replacing the old
// implicit "empty log = start at flow.entry with currentInput: undefined"
// assumption for any entry that isn't itself a `waitFor` (a `waitFor` entry
// already parks safely with no seed at all — see drive-flow.test.ts's own
// "no seed message" case, unaffected by this).
describe("seed() appends the durable input event driveFlow replays from", () => {
  const echo = defineGraph("seed-echo", (flow) => {
    const respond = flow.step(outputs((context) => textOf(context.thread.messages.at(-1))));
    flow.entry(respond);
    respond.then(flow.finish);
  });

  it("seed()'s value reaches the entry node as its own currentInput", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    seed(echo, userText("hello"), ready);

    const result = await driveFlow(echo, ready);

    expect(result).toBe("hello");
  });

  it("a truly empty, never-seeded session just parks — no crash, no implicit start", async () => {
    const store = memoryStore();
    const ready = await runtime({ models: neverCalled, bindings: [], store });

    // Never seeded. driveFlow must not run `respond` with a bogus
    // undefined input, or throw — it just waits, the same as it would at
    // a genuine waitFor with nothing in the inbox yet.
    const outcome = await Promise.race([
      driveFlow(echo, ready).then(() => "resolved" as const),
      new Promise<"parked">((resolve) => {
        setTimeout(() => {
          resolve("parked");
        }, 50);
      }),
    ]);

    expect(outcome).toBe("parked");
  });
});
