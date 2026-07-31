// The ai extension itself — assembles model calls, the tool executor, and
// the message/compaction reducers into one EngineExtension a caller passes
// via runtime({ extensions: [ai({ models, bindings })] }).

import type { EngineExtension } from "../runtime/index.js";
import type { Model } from "./model.js";
import type { ModelPort } from "./model-port.js";
import type { Binding } from "./tool.js";
import { createAiWorkers } from "./tool-executor.js";
import { messageReducer, compactionReducer } from "./reducers.js";

/** `ai()`'s own config — a model resolver plus every tool/toolset binding. @public */
export interface AiConfig {
  readonly models: (model: Model) => ModelPort;
  readonly bindings: Binding[];
}

/**
 * Builds the ai extension: registers the `message`/`compaction` replay folds and the
 * decoupled tool-executor worker. Pass to `runtime({ extensions: [ai({ models, bindings })] })`
 * — `runtime()` itself no longer knows `models`/`bindings` at all; a flow that never calls
 * `context.modelCall`/`context.callTool` doesn't need this extension registered.
 * @public
 */
export function ai(config: AiConfig): EngineExtension {
  return {
    name: "ai",
    reducers: { message: messageReducer, compaction: compactionReducer },
    workers: createAiWorkers(config),
  };
}
