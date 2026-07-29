// Systems running flows — runtime / runFlow. See docs/reference.md.
//
// This file is the thin coordinator: the `Runtime` builder and `runFlow`'s
// own seed-and-drive tail live here. Everything else — routing, fan-out,
// tool/model execution, id generation, the drive loop, and tick/replay —
// lives in src/engine/runtime/ and is re-exported below so
// `import ... from "./engine/runtime.js"` keeps resolving exactly as before.

import type { Model } from "../flow/model.js";
import type { Message } from "../flow/message.js";
import type { Graph } from "../flow/graph.js";
import type { Binding, ToolHandler } from "../flow/tool.js";
import type { ThreadId } from "../flow/thread.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import { defaultErrorHandler, type ErrorHandler } from "./errors.js";
import type { Thread } from "./runtime/routing.js";
import { driveGraph } from "./runtime/drive.js";
import { resolvedTools, startToolExecutor } from "./runtime/execution.js";
import { idFactories, freshThreadId } from "./runtime/ids.js";
import { tickUntilSuspended } from "./runtime/tick.js";

export type { CursorState, TickOutcome } from "./runtime/tick.js";
export { tick, tickUntilSuspended } from "./runtime/tick.js";

/** What a flow runs against — model resolution, bindings, and store. @public */
export interface Runtime {
  readonly models: (model: Model) => ModelPort;
  readonly bindings: Binding[];
  readonly store: SessionStore;
  readonly errorHandlers: ErrorHandler[];
}

/** Expands every binding into one name -> handler map: direct tool bindings as-is, toolset bindings via their `discover()`, called once each. */
async function expandToolsets(bindings: Binding[]): Promise<Map<string, ToolHandler>> {
  const resolved = new Map<string, ToolHandler>();
  for (const binding of bindings) {
    if (binding.kind === "tool") {
      resolved.set(binding.tool.name, binding.handler);
      continue;
    }
    const members = await binding.discover();
    for (const [name, handler] of Object.entries(members)) {
      resolved.set(name, handler);
    }
  }
  return resolved;
}

/**
 * Builds a ready-to-run Runtime, expanding all toolset bindings and auto-starting the decoupled
 * tool executor (see `startToolExecutor` in engine/runtime/execution.ts) against the same
 * bindings — every `toolCall` a running flow commits gets resolved independently, with no
 * separate setup required by any caller.
 * @public
 */
export async function runtime(config: {
  models: (model: Model) => ModelPort;
  bindings: Binding[];
  store: SessionStore;
  errorHandlers?: ErrorHandler[]; // consulted on a step error; a default retry handler runs last
  idFactory?: () => string; // generates every fresh correlation/thread id; omit for the default counters
}): Promise<Runtime> {
  const ready: Runtime = {
    models: config.models,
    bindings: config.bindings,
    store: config.store,
    errorHandlers: [...(config.errorHandlers ?? []), defaultErrorHandler],
  };
  resolvedTools.set(ready, await expandToolsets(config.bindings));
  startToolExecutor(ready);
  if (config.idFactory) idFactories.set(ready, config.idFactory);
  return ready;
}

/**
 * Seeds a new session with a user message, drives it to completion, and
 * resolves with the terminal output. A `parentThreadId` makes it a child —
 * how a tool spawns a sub-agent.
 * @public
 */
export async function runFlow(
  flow: Graph,
  initialPrompt: Message,
  runtime: Runtime,
  options?: { parentThreadId?: ThreadId },
): Promise<unknown> {
  const threadId = freshThreadId(runtime);
  const thread: Thread = {
    id: threadId,
    ...(options?.parentThreadId ? { parentThreadId: options.parentThreadId } : {}),
    messages: [initialPrompt],
    history: [initialPrompt],
  };

  runtime.store.append({ message: initialPrompt }, { type: "message", threadId });

  const result = await driveGraph(flow, runtime, thread, initialPrompt);
  return result.output;
}

/**
 * Drives a flow to completion the same way `tickUntilSuspended` does, except it
 * keeps going: whenever every cursor is parked (nothing left to advance right now),
 * it waits for the store's next `receive()`/`append()` — via `runtime.store.awaitReceive()`
 * — then tries again, instead of returning while work is merely in flight. This is what
 * makes an async tool call (resolved independently by `startToolExecutor`, decoupled from
 * whatever step requested it) actually get noticed once it lands: `tickUntilSuspended` alone
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
 * Deliberately a thin wrapper around `tick()`'s own one-step primitive — not a
 * reimplementation of `driveGraph`'s separate per-node dispatch loop, which already owns this
 * logic correctly for the seed-and-drive-once shape `runFlow` needs. `driveFlow` instead suits
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
