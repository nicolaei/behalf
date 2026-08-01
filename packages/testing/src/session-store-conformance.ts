// The executable definition of what it means to BE a `SessionStore`.
//
// The contract lives in `@behalf-js/engine`, so its acceptance tests live here rather than in
// whichever downstream host happens to write an implementation. A host imports this function,
// hands it a factory, and gets the whole contract checked against its own store — so a store
// that silently drops a field fails at the contract owner's tests, at the version bump, instead
// of surfacing months later as a replay gap in a live session.
//
// Ai-free on purpose: it lives on this package's ROOT subpath, which is engine vocabulary only.
// Every event it commits is one of the engine's own six, and every assertion about a payload is
// structural. A store is engine furniture; nothing here may assume the ai extension is loaded.

import { describe, expect, it } from "vitest";
import type {
  AppendMeta,
  Envelope,
  Event,
  ScopeId,
  SessionStore,
  StreamMeta,
} from "@behalf-js/engine";

const THREAD_ID = "thread-1" as ScopeId;

/**
 * `events()`/`changes()` are typed against the full `Envelope` union, which includes the
 * sequence-less "delta" form. Everything this suite commits is a logged envelope, so it narrows
 * once here rather than casting at each call site.
 */
type LoggedEnvelope = Extract<Envelope, { sequence: number }>;

function logged(envelopes: Envelope[]): LoggedEnvelope[] {
  return envelopes as LoggedEnvelope[];
}

/**
 * Indexes into a committed-log slice, failing loudly rather than handing back `undefined` for a
 * store that committed fewer envelopes than the contract requires — a missing envelope should
 * name itself, not surface as an inscrutable property read on the assertion that follows.
 */
function at(envelopes: LoggedEnvelope[], index: number): LoggedEnvelope {
  const envelope = envelopes[index];
  if (!envelope) {
    throw new Error(
      `expected a committed envelope at index ${String(index)}, ` +
        `but the log holds ${String(envelopes.length)}`,
    );
  }
  return envelope;
}

/**
 * Every field `AppendMeta` declares, populated with a distinguishable value.
 *
 * This is the suite's forcing function, and the reason `AppendMeta` is a named type at all: the
 * annotation is `Required<AppendMeta>`, so the day a new field is added to the contract this
 * object literal stops typechecking until someone fills it in, and `assertMetaRoundTrips` then
 * asserts the new field round-trips WITHOUT anyone having to remember to write that assertion.
 * A contract field can no longer be added without the conformance suite noticing.
 */
const FULLY_POPULATED_APPEND_META: Required<AppendMeta> = {
  type: "signal",
  stepId: "step-with-every-field",
  stepName: "a readable step name",
  threadId: THREAD_ID,
  branchId: "branch-7",
};

/** The same trick for `open`'s metadata: a literal that must grow when `StreamMeta` does. */
const FULLY_POPULATED_STREAM_META: Required<StreamMeta> = {
  correlationId: "correlation-with-every-field",
  type: "signal",
  stepId: "streaming-step",
  stepName: "a readable streaming step name",
  threadId: THREAD_ID,
};

/**
 * Asserts every key present in `meta` survived the round trip onto the committed envelope.
 * Driven off `Object.entries` rather than a hand-written list so a newly added contract field is
 * covered the moment it appears in the literal above.
 */
function assertMetaRoundTrips(envelope: LoggedEnvelope, meta: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(meta)) {
    expect(
      (envelope as unknown as Record<string, unknown>)[field],
      `expected the committed envelope to carry meta field "${field}"`,
    ).toEqual(value);
  }
}

/**
 * The engine's own `signal` event — a non-conversational fact, and the only payload shape this
 * suite ever commits. Deliberately not an ai `message`: the root testing subpath is engine
 * vocabulary only, and a store must work before any extension is registered.
 */
function signalEvent(name: string): Event["signal"] {
  return { name };
}

/**
 * Registers the full `SessionStore` conformance suite as its own `describe` block.
 *
 * Call it from a test file in whichever package owns the implementation:
 *
 * ```ts
 * sessionStoreConformance("memoryStore", () => memoryStore());
 * ```
 *
 * `makeStore` must return a FRESH, empty store each call — the suite builds a new one per test.
 * @public
 */
export function sessionStoreConformance(
  name: string,
  makeStore: () => SessionStore | Promise<SessionStore>,
): void {
  describe(`SessionStore conformance: ${name}`, () => {
    it("starts with an empty log and an empty inbox", async () => {
      const store = await makeStore();
      expect(store.events()).toEqual([]);
      expect(store.inbox()).toEqual([]);
    });

    it("append() commits events, visible via events() in arrival order", async () => {
      const store = await makeStore();
      store.append(signalEvent("first"), { type: "signal", threadId: THREAD_ID });
      store.append(signalEvent("second"), { type: "signal", threadId: THREAD_ID });

      const events = logged(store.events());
      expect(events).toHaveLength(2);
      expect(events.map((envelope) => envelope.event)).toEqual([
        { name: "first" },
        { name: "second" },
      ]);
      expect(at(events, 0)).toMatchObject({ form: "committed", type: "signal" });
      // Sequence strictly increases — a replaying client can rely on the order.
      expect(at(events, 1).sequence).toBeGreaterThan(at(events, 0).sequence);
    });

    it("append() round-trips every meta field the contract declares", async () => {
      const store = await makeStore();
      store.append(signalEvent("everything"), FULLY_POPULATED_APPEND_META);

      const envelope = at(logged(store.events()), 0);
      assertMetaRoundTrips(envelope, FULLY_POPULATED_APPEND_META);
      expect(envelope.event).toEqual({ name: "everything" });
    });

    // `branchId` is the ONLY discriminator between a `forEach` branch's committed events and
    // the outer graph's: branches run on the parent scope, so `threadId` cannot separate them,
    // and branch-graph node ids collide with outer-graph ones. A store that drops it makes
    // replay route a branch's result into the outer step, and driving the flow crashes on
    // reattach. That is a real production outage, not a hypothetical.
    it("keeps outer and branch events on the same stepId distinguishable", async () => {
      const store = await makeStore();
      store.append(signalEvent("outer"), {
        type: "signal",
        threadId: THREAD_ID,
        stepId: "node-3",
      });
      store.append(signalEvent("in a branch"), {
        type: "signal",
        threadId: THREAD_ID,
        stepId: "node-3",
        branchId: "branch-7",
      });

      const events = logged(store.events());
      expect(events).toHaveLength(2);
      expect(at(events, 0).branchId).toBeUndefined();
      expect(at(events, 1).branchId).toBe("branch-7");
    });

    it("omits, rather than invents, meta fields the caller left out", async () => {
      const store = await makeStore();
      store.append(signalEvent("bare"), { type: "signal" });

      const envelope = at(logged(store.events()), 0);
      expect(envelope.stepId).toBeUndefined();
      expect(envelope.stepName).toBeUndefined();
      expect(envelope.threadId).toBeUndefined();
      expect(envelope.branchId).toBeUndefined();
    });

    it("receive() queues a pending entry; consume() finds and removes it", async () => {
      const store = await makeStore();
      expect(store.consume(() => true)).toBeUndefined();

      store.receive({ kind: "message", message: { kind: "chat", text: "hello" } });
      expect(store.inbox()).toHaveLength(1);

      // A predicate that doesn't match leaves the entry queued.
      expect(store.consume((entry) => entry.kind === "signal")).toBeUndefined();
      expect(store.inbox()).toHaveLength(1);

      const consumed = store.consume((entry) => entry.kind === "message");
      expect(consumed).toMatchObject({ kind: "message", message: { kind: "chat" } });
      expect(store.inbox()).toHaveLength(0);
    });

    it("keeps messages and signals in one queue, in arrival order", async () => {
      const store = await makeStore();
      store.receive({ kind: "signal", name: "first" });
      store.receive({ kind: "message", message: { kind: "chat" } });
      store.receive({ kind: "signal", name: "second" });

      expect(store.inbox().map((entry) => entry.kind)).toEqual(["signal", "message", "signal"]);

      // `consume` finds the FIRST match, so two signals drain oldest-first.
      expect(store.consume((entry) => entry.kind === "signal")).toMatchObject({ name: "first" });
      expect(store.consume((entry) => entry.kind === "signal")).toMatchObject({ name: "second" });
      expect(store.inbox().map((entry) => entry.kind)).toEqual(["message"]);
    });

    it("consume() does not disturb the committed log", async () => {
      const store = await makeStore();
      store.append(signalEvent("committed"), { type: "signal" });
      store.receive({ kind: "signal", name: "pending" });
      store.consume(() => true);

      expect(logged(store.events())).toHaveLength(1);
    });

    it("awaitReceive() resolves once receive() adds a fresh pending entry", async () => {
      const store = await makeStore();
      const woken = store.awaitReceive();
      let resolved = false;
      void woken.then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);
      store.receive({ kind: "signal", name: "ping" });
      await woken;
      expect(resolved).toBe(true);
    });

    // A parked `waitFor` loop may be waiting on the COMMITTED log rather than the inbox — a
    // signal-matching `Waitable` re-checks `match()` on every wake. If `append` didn't wake it,
    // that loop would sleep forever with its answer already in the log.
    it("awaitReceive() also resolves on append() committing a fresh event", async () => {
      const store = await makeStore();
      const woken = store.awaitReceive();
      store.append(signalEvent("tick"), { type: "signal" });
      await woken; // would hang forever if append() didn't wake it
    });

    it("awaitReceive() wakes every outstanding waiter, not just the first", async () => {
      const store = await makeStore();
      const both = Promise.all([store.awaitReceive(), store.awaitReceive()]);
      store.receive({ kind: "signal", name: "ping" });
      await both; // would hang forever if only one waiter were resolved
    });

    it("open()/commit() persists the committed event; delta() never does", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);

      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, open: "text" });
      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, text: "partial" });
      // Deltas broadcast live; they never land in the committed log.
      expect(store.events()).toHaveLength(0);

      stream.commit(signalEvent("assembled"));
      const events = logged(store.events());
      expect(events).toHaveLength(1);
      expect(at(events, 0)).toMatchObject({ form: "committed", type: "signal" });
      expect(at(events, 0).event).toEqual({ name: "assembled" });
    });

    it("open()'s committed envelope carries every meta field the contract declares", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);
      stream.commit(signalEvent("assembled"));

      const envelope = at(logged(store.events()), 0);
      // `correlationId` belongs to the live deltas, not to the settled envelope — it is the only
      // `StreamMeta` field that deliberately does not appear on the committed log entry.
      const onEnvelope: Record<string, unknown> = { ...FULLY_POPULATED_STREAM_META };
      delete onEnvelope["correlationId"];
      assertMetaRoundTrips(envelope, onEnvelope);
    });

    it("changes() delivers each streamed delta, tagged with the stream's correlationId", async () => {
      const store = await makeStore();
      const iterator = store.changes()[Symbol.asyncIterator]();
      const stream = store.open(FULLY_POPULATED_STREAM_META);

      // Opening broadcasts an "in-progress" snapshot before any delta arrives.
      const opened = await iterator.next();
      expect(opened.value).toMatchObject({ form: "in-progress", stepId: "streaming-step" });

      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, text: "partial" });
      const delta = await iterator.next();
      expect(delta.value).toMatchObject({
        form: "delta",
        correlationId: FULLY_POPULATED_STREAM_META.correlationId,
        delta: { text: "partial" },
      });
    });

    it("open()/abort() commits exactly one envelope, marked aborted", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);

      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, open: "text" });
      stream.delta({
        correlationId: FULLY_POPULATED_STREAM_META.correlationId,
        text: "partial reply",
      });
      stream.abort();

      const events = logged(store.events());
      expect(events).toHaveLength(1);
      expect(at(events, 0)).toMatchObject({ form: "committed", aborted: true });
    });

    // Whatever payload shape a store reconstructs on abort, the text that actually streamed has
    // to be IN it — that envelope is what the next turn replays from, and losing the partial
    // reply silently rewrites history. The assertion is structural because a store may not name
    // any extension's payload type.
    it("abort() preserves the text that streamed before it", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);
      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, open: "text" });
      stream.delta({
        correlationId: FULLY_POPULATED_STREAM_META.correlationId,
        text: "partial reply",
      });
      stream.abort();

      const envelope = at(logged(store.events()), 0);
      expect(JSON.stringify(envelope.event)).toContain("partial reply");
    });

    // The fastest possible abort: nothing streamed at all. A real provider API (Anthropic,
    // confirmed live) rejects an empty text block outright on the very next turn, so a store
    // must not manufacture one to stand in for the absent content.
    it("abort() with no streamed text does not manufacture an empty text block", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);
      stream.abort();

      const envelope = at(logged(store.events()), 0);
      expect(envelope).toMatchObject({ aborted: true });
      expect(JSON.stringify(envelope.event)).not.toContain('"text":""');
    });

    // A model port's own async work is RACED by abort, not cancelled: a still-running provider
    // stream that hasn't noticed keeps calling delta()/commit() on an already-settled stream.
    // The visible symptom of a missing guard is an aborted turn whose reply keeps growing.
    it("drops delta() and commit() after the stream has settled", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);

      stream.delta({ correlationId: FULLY_POPULATED_STREAM_META.correlationId, text: "partial" });
      stream.abort();

      const iterator = store.changes()[Symbol.asyncIterator]();
      const nextBroadcast = iterator.next();

      stream.delta({
        correlationId: FULLY_POPULATED_STREAM_META.correlationId,
        text: " arriving too late",
      });
      stream.commit(signalEvent("a whole different reply, arriving too late"));

      const raced = await Promise.race([
        nextBroadcast.then(() => "delivered" as const),
        new Promise<"nothing">((resolve) => {
          setTimeout(() => {
            resolve("nothing");
          }, 50);
        }),
      ]);
      expect(raced).toBe("nothing");
      expect(logged(store.events())).toHaveLength(1); // still just the abort's own commit
    });

    it("a second commit() on the same stream is dropped", async () => {
      const store = await makeStore();
      const stream = store.open(FULLY_POPULATED_STREAM_META);
      stream.commit(signalEvent("first and only"));
      stream.commit(signalEvent("second, ignored"));

      const events = logged(store.events());
      expect(events).toHaveLength(1);
      expect(at(events, 0).event).toEqual({ name: "first and only" });
    });

    it("changes() delivers a live committed envelope to a subscriber after append()", async () => {
      const store = await makeStore();
      const iterator = store.changes()[Symbol.asyncIterator]();
      const next = iterator.next();

      store.append(signalEvent("live"), { type: "signal", threadId: THREAD_ID });

      const result = await next;
      expect(result.done).toBe(false);
      expect(result.value).toMatchObject({ form: "committed", type: "signal" });
    });

    it("changes() carries every meta field on the envelope it delivers", async () => {
      const store = await makeStore();
      const iterator = store.changes()[Symbol.asyncIterator]();
      const next = iterator.next();

      store.append(signalEvent("live"), FULLY_POPULATED_APPEND_META);

      const result = await next;
      assertMetaRoundTrips(result.value as LoggedEnvelope, FULLY_POPULATED_APPEND_META);
    });

    it("gives every changes() subscriber its own independent feed", async () => {
      const store = await makeStore();
      const first = store.changes()[Symbol.asyncIterator]().next();
      const second = store.changes()[Symbol.asyncIterator]().next();

      store.append(signalEvent("broadcast"), { type: "signal" });

      for (const delivered of await Promise.all([first, second])) {
        expect(delivered.value).toMatchObject({ form: "committed", type: "signal" });
      }
    });

    it("events() hands back a snapshot, not the live log", async () => {
      const store = await makeStore();
      store.append(signalEvent("first"), { type: "signal" });
      const snapshot = store.events();
      store.append(signalEvent("second"), { type: "signal" });

      expect(snapshot).toHaveLength(1);
      expect(store.events()).toHaveLength(2);
    });

    it("inbox() hands back a snapshot, not the live queue", async () => {
      const store = await makeStore();
      store.receive({ kind: "signal", name: "first" });
      const snapshot = store.inbox();
      store.receive({ kind: "signal", name: "second" });

      expect(snapshot).toHaveLength(1);
      expect(store.inbox()).toHaveLength(2);
    });
  });
}
