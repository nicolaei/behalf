import { describe, it, expect } from "vitest";
import { adapters } from "../../index.js";
import { loggedEnvelopes } from "./support.js";
import type { ThreadId } from "../../index.js";

describe.skip("the delta stream: store.open/commit/abort, store.changes()", () => {
  // Every scenario here needs memoryStore's open()/changes() to be real — both
  // currently throw/no-op. Written now so the shape is pinned down before that
  // slice starts; each `it` names the reference.md passage it verifies.

  it("does not persist partial content — delta() alone leaves the log untouched", () => {
    // ref: "Deltas live in the store, not the log. Partial content streams
    // live and is dropped; only the finished event is committed."
    const store = adapters.stores.memoryStore();
    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });

    stream.delta({ correlationId: "1", text: "partial" });

    expect(store.events()).toHaveLength(0);
  });

  it("commits a new envelope when the stream is committed", () => {
    // ref: "commit(event: Event[EventType]): void // finalize into the log"
    const store = adapters.stores.memoryStore();
    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });

    stream.commit({ value: "done" });

    const [envelope] = loggedEnvelopes(store);
    expect(loggedEnvelopes(store)).toHaveLength(1);
    expect(envelope?.aborted).toBeFalsy();
  });

  it("commits an aborted envelope when the stream is aborted", () => {
    // ref: "abort(): void // commit what streamed, mark the envelope aborted"
    const store = adapters.stores.memoryStore();
    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });
    stream.delta({ correlationId: "1", text: "partial" });

    stream.abort();

    const [envelope] = loggedEnvelopes(store);
    expect(envelope?.aborted).toBe(true);
  });

  it("yields delta-form envelopes to an active changes() subscriber", async () => {
    // ref: "changes(): AsyncIterable<Envelope> // yields envelopes of every form"
    const store = adapters.stores.memoryStore();
    const received: string[] = [];
    const subscription = (async () => {
      for await (const envelope of store.changes()) {
        received.push(envelope.form);
        if (received.length >= 1) break;
      }
    })();

    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });
    stream.delta({ correlationId: "1", text: "partial" });

    await subscription;

    expect(received).toContain("delta");
  });

  it("yields committed envelopes to an active changes() subscriber", async () => {
    // ref: "changes(): AsyncIterable<Envelope> // yields envelopes of every form"
    const store = adapters.stores.memoryStore();
    const received: string[] = [];
    const subscription = (async () => {
      for await (const envelope of store.changes()) {
        received.push(envelope.form);
        if (received.length >= 1) break;
      }
    })();

    store.append({ value: "done" }, { type: "output" });

    await subscription;

    expect(received).toContain("committed");
  });
});
