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
import { resolvedTools } from "./runtime/execution.js";
import { idFactories, freshThreadId } from "./runtime/ids.js";

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

/** Builds a ready-to-run Runtime, expanding all toolset bindings. @public */
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
