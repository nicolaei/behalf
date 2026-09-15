// Systems running flows — the `Runtime` builder, `seed()`, and `driveFlow()`.
// See docs/reference.md.
//
// This file is the thin coordinator; everything else — routing, fan-out,
// tool/model execution, id generation, the node-level drive machinery, and
// tick/replay — lives alongside it in src/runtime/ and is re-exported below so
// `import ... from "./runtime/runtime.js"` keeps resolving exactly as before.

import type { Graph } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { SessionStore } from "../session/session-store.js";
import type { EngineExtension } from "./extension.js";
import { defaultErrorHandler, type ErrorHandler } from "./errors.js";
import { idFactories, freshScopeId } from "./ids.js";
import { tickUntilSuspended } from "./tick.js";

export type { CursorState, TickOutcome } from "./tick.js";
export { tick, tickUntilSuspended } from "./tick.js";

/**
 * What a flow runs against — the durable store, error handling, and every registered
 * extension's own capabilities. `runtime()` no longer knows `models`/`bindings` directly (B2.7):
 * a flow whose steps call `context.modelCall`/`context.callTool` needs the ai extension
 * registered via `extensions: [ai({ models, bindings })]` — see `ai()` in `ai/extension.ts`.
 * @public
 */
export interface Runtime {
  readonly store: SessionStore;
  readonly errorHandlers: ErrorHandler[];
  readonly extensions: EngineExtension[]; // registered capabilities; their stepContext() is merged into every StepContext
  /** Aborts the signal handed to every extension's `workers`, then awaits each worker's own returned promise settling. Idempotent to call more than once — later calls just re-await already-settled promises. */
  stop(): Promise<void>;
  /**
   * Stops the run in flight, if there is one. A verb the runtime answers, not a message a
   * caller places in the inbox: the caller no longer has to know whether pressing stop is
   * appropriate, because the runtime does.
   *
   * - No run in flight: returns, writing nothing, nowhere. There is nothing to mark and no
   *   trap is armed under the next turn.
   * - Already stopping: returns. "Stopping" is an in-memory flag — a fact about this
   *   process, not about the conversation — so it is never a log entry, and N presses
   *   during one run produce one aborted turn.
   * - Otherwise: asks every extension to cancel its live work (`abortLiveWork`), which for
   *   ai means every live tool call's signal fires and the in-flight model call is
   *   preempted. The aborted step is then routed to the nearest declared `onAbort`, exactly
   *   as it always was.
   *
   * A stop can land where there is nothing to cancel — between a committed `toolResult` and
   * the start of the next model call — and that window marks nothing. Accepted by design:
   * the run stopped, it just stopped silently.
   */
  abort(): void;
}

/**
 * Builds a ready-to-run Runtime: starts every registered extension's `waitables` (each park
 * condition it can satisfy) and `workers` (background loops — the ai extension's decoupled tool
 * executor, once `extensions: [ai({ models, bindings })]` registers it), with no separate setup
 * required by any caller.
 * @public
 */
export function runtime(config: {
  store: SessionStore;
  extensions?: EngineExtension[]; // capabilities registering their own waitables/workers/reducers/context contributions
  errorHandlers?: ErrorHandler[]; // consulted on a step error; a default retry handler runs last
  idFactory?: () => string; // generates every fresh correlation/scope id; omit for the default counters
}): Promise<Runtime> {
  const extensions = config.extensions ?? [];
  const abortController = new AbortController();
  const workerPromises: Promise<void>[] = [];

  // In-memory only, deliberately: whether this process is already stopping says nothing
  // about the conversation, so it must never become a log entry. Self-healing — cleared the
  // next time abort() finds nothing in flight, which is what lets a later run be stopped.
  let stopping = false;

  const ready: Runtime = {
    store: config.store,
    errorHandlers: [...(config.errorHandlers ?? []), defaultErrorHandler],
    extensions,
    stop: async () => {
      abortController.abort();
      await Promise.allSettled(workerPromises);
    },
    abort: () => {
      if (!extensions.some((extension) => extension.hasLiveWork?.(ready))) {
        stopping = false;
        return;
      }
      if (stopping) return;
      stopping = true;
      for (const extension of extensions) extension.abortLiveWork?.(ready);
    },
  };

  for (const extension of extensions) {
    for (const source of extension.waitables ?? []) source.start(config.store);
    for (const start of extension.workers?.(ready, abortController.signal) ?? []) {
      workerPromises.push(start());
    }
  }
  if (config.idFactory) idFactories.set(ready, config.idFactory);
  return Promise.resolve(ready);
}

/**
 * Appends a flow's starting value to a fresh session's log as the durable
 * `input` event (see `Event["input"]`) — the log's own first fact, node =
 * `flow.entry`, value = `input`. This is what `tick`/`driveFlow` replay from
 * to establish a session's opening cursor; a store with no `input` event yet
 * has no starting cursor at all, and `tick` just reports it parked instead of
 * assuming some other implicit start condition.
 *
 * Mints the session's starting scope and tags the event with it — replay
 * re-syncs its current scope from each envelope's own tag (see
 * `replayPosition`), and an extension's `state()` fold only sees events
 * tagged with the scope it's asked about, so an untagged seed would be
 * invisible to (e.g.) ai's own thread fold. Returns the minted scope so
 * `seed()`'s own caller drives on the same one instead of minting a second.
 * @public
 */
export function seed(flow: Graph, input: unknown, runtime: Runtime): ScopeId {
  const scope = freshScopeId(runtime);
  runtime.store.append({ node: flow.entry, value: input }, { type: "input", threadId: scope });
  return scope;
}

/**
 * Drives a flow to completion the same way `tickUntilSuspended` does, except it
 * keeps going: whenever every cursor is parked (nothing left to advance right now),
 * it waits for the store's next `receive()`/`append()` — via `runtime.store.awaitReceive()`
 * — then tries again, instead of returning while work is merely in flight. This is what
 * makes an async tool call (resolved independently by the ai extension's decoupled tool
 * executor, if registered) actually get noticed once it lands: `tickUntilSuspended` alone
 * stops the moment a `waitFor(toolCall(id))` peeks and finds nothing yet, and nothing ever
 * calls it again on its own.
 *
 * Subscribes to `awaitReceive()` *before* calling `tickUntilSuspended`, not after — closes a
 * lost-wakeup window that would otherwise exist: `awaitReceive()` is edge-triggered (a fresh
 * promise, no memory of past wakes; see session-store.ts), so a `receive()`/`append()` that
 * fires while `tickUntilSuspended` itself is still running would be missed by a listener only
 * registered after that call returns — leaving `driveFlow` awaiting a later promise that only
 * resolves on some future, unrelated event, or never. Awaiting the same already-registered
 * promise afterward is always safe, even if it resolved before the check even started: a
 * spurious/early wake just costs one extra loop iteration (store.awaitReceive()'s own contract:
 * a wake makes no promise about what changed, and a caller just re-checks and, if nothing new,
 * goes back to sleep).
 *
 * A thin wrapper around `tick()`'s own one-step primitive — the engine's only driver.
 * a long-lived session: no initial prompt required (a fresh flow parks at its own entry
 * `waitFor` until a message arrives), and it keeps resuming across as many turns as the caller
 * needs, in one call, until the flow's root cursor reports `done`.
 * @public
 */
export async function driveFlow(flow: Graph, runtime: Runtime): Promise<unknown> {
  for (;;) {
    const woken = runtime.store.awaitReceive();
    const outcome = await tickUntilSuspended(flow, runtime);
    if (outcome.every((cursor) => cursor.status === "done")) {
      return outcome.find((cursor) => cursor.parent === undefined)?.result;
    }
    await woken;
  }
}
