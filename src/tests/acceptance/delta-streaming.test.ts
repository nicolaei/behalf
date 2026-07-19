import { describe, it, expect } from "vitest";
import { adapters } from "../../index.js";
import type { ThreadId } from "../../index.js";
import { loggedEnvelopes } from "./support.js";

describe("streaming partial content before it's committed to the log", () => {
  // Every scenario here needs memoryStore's open()/changes() to be real — both
  // currently throw/no-op. Written now so the shape is pinned down before that
  // slice starts; each `it` names the reference.md passage it verifies.

  // Guards a `for await` loop against hanging forever if `changes()` never
  // yields — a real risk while the implementation underneath is still a stub.
  async function firstEnvelope(store: ReturnType<typeof adapters.stores.memoryStore>) {
    return Promise.race([
      (async () => {
        for await (const envelope of store.changes()) return envelope;
        throw new Error("changes() completed without yielding an envelope");
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("changes() did not yield within 1000ms"));
        }, 1000);
      }),
    ]);
  }

  // Same guard, but skips past the in-progress envelope open() now broadcasts
  // immediately — these callers want the first envelope that actually carries
  // streamed content, not the "a stream just started" marker.
  async function firstContentEnvelope(store: ReturnType<typeof adapters.stores.memoryStore>) {
    return Promise.race([
      (async () => {
        for await (const envelope of store.changes()) {
          if (envelope.form !== "in-progress") return envelope;
        }
        throw new Error("changes() completed without yielding a content envelope");
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("changes() did not yield a content envelope within 1000ms"));
        }, 1000);
      }),
    ]);
  }

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
    // not-aborted may read as `false` or simply absent — both are "not aborted"
    expect(envelope?.aborted).not.toBe(true);
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

  it("yields a delta-form envelope to an active changes() subscriber", async () => {
    // ref: "changes(): AsyncIterable<Envelope> // yields envelopes of every form"
    const store = adapters.stores.memoryStore();
    const received = firstContentEnvelope(store);

    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });
    stream.delta({ correlationId: "1", text: "partial" });

    expect((await received).form).toBe("delta");
  });

  it("yields a committed-form envelope when a stream is committed", async () => {
    // ref: "changes(): AsyncIterable<Envelope> // yields envelopes of every form"
    // deliberately drives this through store.open()/stream.commit(), not
    // store.append() directly — the two paths could otherwise diverge
    // (commit() failing to notify changes() subscribers) with no test to catch it
    const store = adapters.stores.memoryStore();
    const received = firstContentEnvelope(store);

    const stream = store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });
    stream.commit({ value: "done" });

    expect((await received).form).toBe("committed");
  });

  // Needs open() to broadcast a form: "in-progress" envelope immediately on
  // open, before any delta — currently open() never broadcasts anything until
  // the first delta()/commit(). Written now so the shape is pinned down.
  it("yields an in-progress envelope the instant a stream opens, before any delta", async () => {
    // ref: "A late-joining client sees the committed log, then an in-progress
    // snapshot for any stream still open, then deltas as they occur."
    const store = adapters.stores.memoryStore();
    const received = firstEnvelope(store);

    store.open({
      correlationId: "1",
      type: "output",
      stepId: "step-1",
      threadId: "thread-1" as ThreadId,
    });

    expect((await received).form).toBe("in-progress");
  });
});
