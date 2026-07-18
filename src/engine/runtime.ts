// Systems running flows — runtime / runFlow. See docs/reference.md.

import type { Model } from "../flow/model.js";
import type { Message } from "../flow/message.js";
import type { Graph } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ThreadId } from "../flow/thread.js";
import type { ModelPort } from "./model-port.js";
import type { SessionStore } from "./session-store.js";
import type { ErrorHandler } from "./errors.js";

/** What a flow runs against. Opaque — its shape settles once `runtime()` is implemented. */
export interface Runtime {
  readonly _brand: "Runtime";
}

export declare function runtime(config: {
  models: (model: Model) => ModelPort;
  bindings: Binding[];
  store: SessionStore;
  errorHandlers?: ErrorHandler[]; // consulted on a step error; a default retry handler runs last
}): Promise<Runtime>;

/**
 * Seeds a new session with a user message, drives it to completion, and
 * resolves with the terminal output. A `parentThreadId` makes it a child —
 * how a tool spawns a sub-agent.
 */
export declare function runFlow(
  flow: Graph,
  initialPrompt: Message,
  runtime: Runtime,
  options?: { parentThreadId?: ThreadId },
): Promise<unknown>;
