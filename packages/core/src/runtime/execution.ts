// Waiting primitives shared by every non-model, non-tool `waitFor`/`interrupt`
// path: polling the pending inbox for a message, draining/committing signal
// entries, and racing a waitFor node's own Waitable against armed interrupts.
// The ai-specific halves that used to live here — `runModelCall` and the
// decoupled tool executor — physically moved to `ai/model-call.ts` and
// `ai/tool-executor.ts` (B2.7); this file keeps the generic waiting
// machinery every drive-loop path (message- or signal-based alike) needs
// regardless of whether the ai extension is even registered.

// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8: thread extraction) waitForMessage/peekMessageFromInbox key off ai-shaped MessageKind/UserMessage; removed when message-kind waiting moves to ai's own reducers/waitables.
import type { MessageKind, UserMessage } from "../ai/message.js";
import type { Waitable } from "../graph/waitable.js";
import type { NodeId } from "../graph/graph.js";
import type { ThreadId } from "../graph/thread.js";
import type { SessionStore } from "../session/session-store.js";
import { unreachable } from "./errors.js";

/**
 * Parks until `poll` returns a value, waking on `store.awaitReceive()` so a
 * `store.receive()` racing this call — before or after it starts — is never
 * missed, without spinning a timer while nothing's ready. Stops early once
 * `stop` says so, if given.
 */
async function pollInbox<T>(
  store: SessionStore,
  poll: () => T | undefined,
  stop?: () => boolean,
): Promise<T | undefined> {
  while (!stop?.()) {
    const value = poll();
    if (value) return value;
    await store.awaitReceive();
  }
  return undefined;
}

/** Consumes one pending `signal` entry, if any is queued, and commits it to the log as a `signal` event — the "drain one pending signal and commit it" step every non-message `waitFor` path repeats (blocking here in `waitForSignal`/`waitForRace`, or peeked non-blockingly in `tick`/`runBranchNode`) until its `Waitable`'s own `match()` catches up with the log. `threadId`, when given, tags the committed event with the waitFor node's own thread — a fan-out branch's own forked thread, so replay can later recognize which branch this signal resolved (see `replayBranchSignal`, fan-out.ts); the top-level single-line path doesn't need it (there's only one line to attribute anything to) but passes its own thread id anyway, for parity. Returns whether an entry was drained. */
export function drainOnePendingSignal(store: SessionStore, threadId?: ThreadId): boolean {
  const entry = store.consume((candidate) => candidate.kind === "signal");
  if (entry?.kind !== "signal") return false;
  store.append(
    { name: entry.name, ...(entry.payload !== undefined ? { payload: entry.payload } : {}) },
    { type: "signal", ...(threadId ? { threadId } : {}) },
  );
  return true;
}

/** Parks until the inbox has a message of the given kind. */
export async function waitForMessage(
  store: SessionStore,
  kinds: readonly MessageKind[],
): Promise<UserMessage> {
  const entry = await pollInbox(store, () =>
    store.consume(
      (candidate) =>
        candidate.kind === "message" &&
        candidate.message.kind !== undefined &&
        kinds.includes(candidate.message.kind),
    ),
  );
  // pollInbox only returns undefined when given a `stop` predicate, which this call omits.
  if (entry?.kind !== "message") unreachable("waitForMessage resolved without a message");
  return entry.message;
}

/** Non-blocking counterpart to `waitForMessage`: checks whether a message of one of the given kinds is already sitting in the inbox, consuming and returning it if so — `undefined` otherwise, never parking. Shared by tick's own waitFor handling and `runBranchNode`'s `"peek"` mode, both of which must never block. */
export function peekMessageFromInbox(
  store: SessionStore,
  kinds: readonly MessageKind[],
): UserMessage | undefined {
  const entry = store.consume(
    (candidate) =>
      candidate.kind === "message" &&
      candidate.message.kind !== undefined &&
      kinds.includes(candidate.message.kind),
  );
  return entry?.kind === "message" ? entry.message : undefined;
}

/** Checks a non-message `Waitable`'s own `match()` against the committed log, draining and committing at most one pending `signal` entry (tagged with `threadId`, when given) if nothing matched yet, then re-checking once more — the peek shape every non-blocking, non-message `waitFor` site (tick's own waitFor handling, `runBranchNode`'s `"peek"` mode) shares. `undefined` if still unmatched; never blocks, unlike `waitForSignal`. */
export function peekSignalMatch<T>(
  store: SessionStore,
  waitable: Waitable<T>,
  threadId?: ThreadId,
): T | undefined {
  let matched = waitable.match(store.events());
  if (matched === undefined && drainOnePendingSignal(store, threadId)) {
    matched = waitable.match(store.events());
  }
  return matched;
}

/**
 * Parks until a non-`userInput` `Waitable` (a signal-based one, today's only
 * other provider) is satisfied: drains one pending `signal` entry at a time,
 * committing each as a `signal` event — a durable fact, never folded into
 * `thread.messages` — then re-checks the `Waitable`'s own `match()` against
 * the committed log. A signal that doesn't satisfy this waitFor still gets
 * committed (so a later, different waitFor or a replay can see it) and
 * polling continues. Mirrors `waitForMessage`'s polling shape, but the match
 * itself is delegated to the `Waitable` rather than a kind check against the
 * live inbox, since a signal's identity lives in its committed event, not in
 * anything message-shaped.
 */
export async function waitForSignal<T>(
  store: SessionStore,
  waitable: Waitable<T>,
  threadId?: ThreadId,
): Promise<T> {
  const result = await pollInbox(store, () => {
    for (;;) {
      const matched = waitable.match(store.events());
      if (matched !== undefined) return { value: matched };

      if (!drainOnePendingSignal(store, threadId)) return undefined;
      // Loop back around: the freshly committed signal may or may not be
      // what `waitable` is looking for — either way, re-check `match()`
      // before trying to drain another pending entry.
    }
  });
  return result?.value as T;
}

/** One armed `interrupt` node together with its message kind, if it has one — precomputed once per race so `waitForRace` never calls `tryMessageKindOf` per poll tick. */
interface ArmedInterrupt {
  id: NodeId;
  waitable: Waitable<unknown>;
  messageKind: MessageKind | undefined;
}

/** Which armed Waitable a race settled on: the waitFor node's own ("self"), or a specific `interrupt` node — never both, since `waitForRace` stops polling the instant either is satisfied. */
export type RaceWinner =
  | { kind: "self"; message: UserMessage }
  | { kind: "interrupt"; interrupt: { id: NodeId; waitable: Waitable<unknown> }; value: unknown };

/** Step (a) of `waitForRace`'s poll: consumes a pending message matching the waitFor node's own kind or any message-based interrupt's kind, and classifies which one it belongs to — the interrupt whose kind matches, or "self" (the waitFor node's own Waitable) when none does. `undefined` when no matching message is queued yet. */
function consumeRaceMessage(
  store: SessionStore,
  messageKinds: readonly MessageKind[],
  interrupts: readonly ArmedInterrupt[],
): RaceWinner | undefined {
  const message = store.consume(
    (candidate) =>
      candidate.kind === "message" &&
      candidate.message.kind !== undefined &&
      messageKinds.includes(candidate.message.kind),
  );
  if (message?.kind !== "message") return undefined;
  const interrupt = interrupts.find((candidate) => candidate.messageKind === message.message.kind);
  return interrupt
    ? { kind: "interrupt", interrupt, value: message.message }
    : { kind: "self", message: message.message };
}

/** Step (b) of `waitForRace`'s poll: checks every signal-based interrupt's own `match()` against the committed log, returning the first one satisfied. `undefined` when none is. */
function checkSignalInterrupts(
  signalInterrupts: readonly ArmedInterrupt[],
  store: SessionStore,
): RaceWinner | undefined {
  for (const interrupt of signalInterrupts) {
    const matched = interrupt.waitable.match(store.events());
    if (matched !== undefined) return { kind: "interrupt", interrupt, value: matched };
  }
  return undefined;
}

/**
 * Races a `waitFor` node's own message-based `Waitable` against every armed
 * `interrupt` — message-based or signal-based alike — resolving with
 * whichever is satisfied first. Each poll tick:
 *  1. checks the pending inbox for a message matching the node's own kind
 *     or any message-based interrupt's kind (same shape as `waitForMessage`);
 *  2. checks every signal-based interrupt's own `match()` against the
 *     committed log;
 *  3. if neither is ready, drains one pending signal, commits it (so a
 *     match on step 2 sees it next tick, or a different Waitable's later
 *     race can), and loops.
 * A signal-based interrupt's `match()` — not a kind string — decides
 * whether it fired, since a signal has no message kind to compare; a
 * message-based interrupt is still resolved by kind, same as today,
 * because `waitForMessage`'s inbox check needs a kind to look for before
 * any message has arrived to call `match()` on. Only interrupt nodes ever
 * feed the signal branch — the waitFor node's own Waitable is always
 * message-based here, `driveWaitForNode` having already routed a
 * non-message Waitable through `waitForSignal` directly with no race.
 */
export async function waitForRace(
  store: SessionStore,
  waitKind: MessageKind,
  interrupts: readonly ArmedInterrupt[],
): Promise<RaceWinner> {
  const messageKinds = [
    waitKind,
    ...interrupts
      .map((interrupt) => interrupt.messageKind)
      .filter((kind): kind is MessageKind => kind !== undefined),
  ];
  const signalInterrupts = interrupts.filter((interrupt) => interrupt.messageKind === undefined);

  const result = await pollInbox(store, () => {
    for (;;) {
      const messageWinner = consumeRaceMessage(store, messageKinds, interrupts);
      if (messageWinner) return { value: messageWinner };

      const signalWinner = checkSignalInterrupts(signalInterrupts, store);
      if (signalWinner) return { value: signalWinner };

      if (!drainOnePendingSignal(store)) return undefined;
      // Loop back around: re-check every signal-based interrupt's match()
      // against the freshly committed signal before draining another one.
    }
  });
  // pollInbox only returns undefined when given a `stop` predicate, which this call omits.
  if (!result) unreachable("waitForRace resolved without a winner");
  return result.value;
}
