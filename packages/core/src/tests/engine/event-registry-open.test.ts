import { describe, it, expect } from "vitest";
import { memoryStore } from "@behalf-js/stores";
import type { Event, EventType } from "../../session/event.js";
import type { ThreadId } from "../../graph/thread.js";
// Side-effect import: this is where B2.5 puts the ai extension's own
// declaration-merge augmentation of `Event` (message/toolCall/toolResult/
// compaction). Its mere existence — a module OTHER than session/event.ts
// contributing keys to the same `Event` interface — is part of the proof
// the registry is open: pre-B2.5 this module doesn't exist yet (those keys
// are hardcoded directly in session/event.ts instead), so this import fails
// to resolve. That's this file's real RED signal; the customPing case below
// additionally proves a THIRD party (neither core nor ai) can extend the
// same registry the same way.
import "../../ai/event.js";

// B2.5 — proves `Event` is a genuinely OPEN registry, not "core plus one
// hardcoded ai extension". A brand-new, test-only event type is declared
// here via its own `declare module` augmentation — the same declaration-
// merging technique the ai extension uses for message/toolCall/toolResult/
// compaction (see ai/event.ts) — and appended straight through the raw
// `SessionStore` contract. Nothing about this event type is known to core;
// if the store or `Event` still hardcoded a closed set of keys, this
// wouldn't compile (an unknown key) or wouldn't round-trip.
declare module "../../session/event.js" {
  interface Event {
    customPing: { note: string };
  }
}

describe("Event is an open registry", () => {
  it("a test-only event type declared via declaration merging can be appended and read back", () => {
    const store = memoryStore();

    const payload: Event["customPing"] = { note: "hello" };
    store.append(payload, { type: "customPing" satisfies EventType });

    const events = store.events();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("customPing");
    expect(events[0]?.event).toEqual({ note: "hello" });
  });

  it("openStream also accepts and commits the custom event type", () => {
    const store = memoryStore();

    const stream = store.open({
      correlationId: "corr-1",
      type: "customPing" satisfies EventType,
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });
    stream.commit({ note: "streamed" });

    const committed = store.events().find((envelope) => envelope.type === "customPing");
    expect(committed?.event).toEqual({ note: "streamed" });
  });
});
