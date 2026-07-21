// Acceptance test support — DSL helpers, not part of the public library surface.

import { runtime, adapters } from "../../index.js";
import type {
  Runtime,
  Message,
  AssistantMessage,
  Envelope,
  EventType,
  SessionStore,
} from "../../index.js";

/**
 * A runtime with only a store — no model port, no tool bindings. For tests
 * whose flow never calls a model or a tool.
 */
export async function storeOnlyRuntime(): Promise<Runtime> {
  return runtime({ models: neverCalled, bindings: [], store: adapters.stores.memoryStore() });
}

/** A runtime wired with `fakePort` as the model resolver, no tool bindings. */
export async function fakePortRuntime(): Promise<Runtime> {
  return runtime({
    models: () => adapters.models.fakePort,
    bindings: [],
    store: adapters.stores.memoryStore(),
  });
}

/** A model resolver for tests whose flow is expected to never call a model. */
export function neverCalled(): never {
  throw new Error("no model call expected in this test");
}

/** Pulls the first text block's text out of a message, for assertions. */
export function textOf(message: Message | undefined): string {
  const block = message?.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : "";
}

/** Submits a scripted "approval" message a parked waitFor/branch is waiting on. */
export function submitApproval(store: SessionStore): void {
  store.receive({
    kind: "message",
    message: {
      role: "user",
      intent: "standard",
      kind: "approval",
      content: [{ type: "text", text: "yes" }],
    },
  });
}

/** A scripted assistant message with a single text block — for hand-rolled test ModelPorts. */
export function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

/** A scripted assistant message with a single tool call — for hand-rolled test ModelPorts. */
export function assistantToolCall(name: string, input: unknown): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "toolCall", correlationId: "1", name, input }],
    usage: { input: 1, output: 1 },
  };
}

/** A scripted assistant message with several tool calls, correlationIds "1".. "N" in order. */
export function assistantToolCalls(calls: { name: string; input: unknown }[]): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: calls.map((call, index) => ({
      type: "toolCall" as const,
      correlationId: String(index + 1),
      name: call.name,
      input: call.input,
    })),
    usage: { input: 1, output: 1 },
  };
}

export type CommittedEnvelope = Extract<Envelope, { type: EventType }>;

// Tightened to "committed" only (not "in-progress") — in-progress snapshots are
// provisional and shouldn't be conflated with settled log data in assertions.
function isCommitted(envelope: Envelope): envelope is CommittedEnvelope {
  return envelope.form === "committed";
}

/** The `.type` of every committed envelope in the store, in order — asserts the shape of the log. */
export function loggedEventTypes(store: SessionStore): EventType[] {
  return store
    .events()
    .filter(isCommitted)
    .map((envelope) => envelope.type);
}

/** The committed envelope at a position in the log, narrowed so `.event` is safe to read. */
export function loggedEventAt(store: SessionStore, index: number): CommittedEnvelope {
  const envelope = store.events().filter(isCommitted)[index];
  if (!envelope) throw new Error(`no committed event at index ${String(index)}`);
  return envelope;
}

/** Every committed envelope in the store, in order — for assertions that need more than `.type`. */
export function loggedEnvelopes(store: SessionStore): CommittedEnvelope[] {
  return store.events().filter(isCommitted);
}

/**
 * Awaits the next committed envelope of `type` on `store.changes()` — for
 * asserting something eventually gets committed asynchronously, independent
 * of whatever kicked it off. Subscribes before the caller triggers the
 * async work, so nothing committed in the same tick is missed.
 */
export async function awaitEventType(
  store: SessionStore,
  type: EventType,
): Promise<CommittedEnvelope> {
  for await (const envelope of store.changes()) {
    if (envelope.form === "committed" && envelope.type === type) return envelope;
  }
  throw new Error(`changes() ended without a committed "${type}" envelope`);
}
