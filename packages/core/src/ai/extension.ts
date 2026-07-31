// The ai extension itself — assembles model calls, the tool executor, the
// message/compaction/threadGenesis reducers, and the `ctx.thread` context
// contribution into one EngineExtension a caller passes via
// runtime({ extensions: [ai({ models, bindings })] }).

import "./context.js"; // side-effect: registers the StepContext/EdgeContext.thread declaration merge
import type { EngineExtension, ExecutionScope } from "../runtime/index.js";
import type { Model } from "./model.js";
import type { ModelPort } from "./model-port.js";
import type { Binding } from "./tool.js";
import type { AgentSpawner } from "./agent-spawner.js";
import type { Message } from "./message.js";
import { createAiWorkers } from "./tool-executor.js";
import {
  messageReducer,
  compactionReducer,
  threadGenesisReducer,
  inputReducer,
  buildThreadContext,
} from "./thread.js";

/** `ai()`'s own config — a model resolver, every tool/toolset binding, and optionally the `AgentSpawner` backing `ToolContext.spawnAgent`. @public */
export interface AiConfig {
  readonly models: (model: Model) => ModelPort;
  readonly bindings: Binding[];
  /** Required only by a flow whose tools call `context.spawnAgent`; omitting it makes that call fail loudly rather than silently. */
  readonly spawner?: AgentSpawner;
}

/** The shape ai interprets `context.invalidate`'s generic `payload` as, when it carries one — a rerun's own reason message, folded onto whichever scope resulted the same way `ctx.thread.start`/`say` would. */
interface InvalidatePayload {
  reason?: Message;
}

/**
 * Builds the ai extension: registers the `message`/`compaction`/`threadGenesis` replay
 * folds, the `ctx.thread` context contribution (on both `StepContext` and `EdgeContext`),
 * the `seedScope` hook that interprets `context.invalidate`'s own generic `payload` as a
 * rerun's reason message, and the decoupled tool-executor worker. Pass to
 * `runtime({ extensions: [ai({ models, bindings })] })` — `runtime()` itself no longer
 * knows `models`/`bindings` at all; a flow that never calls `context.modelCall`/
 * `context.callTool`/`context.thread` doesn't need this extension registered.
 * @public
 */
export function ai(config: AiConfig): EngineExtension {
  return {
    name: "ai",
    reducers: {
      input: inputReducer,
      message: messageReducer,
      compaction: compactionReducer,
      threadGenesis: threadGenesisReducer,
    },
    stepContext(scope: ExecutionScope) {
      return { thread: buildThreadContext(scope, () => scope.label?.()) };
    },
    edgeContext(scope: ExecutionScope) {
      return { thread: buildThreadContext(scope) };
    },
    seedScope(_scope, payload, appendEvent) {
      const reason = (payload as InvalidatePayload | undefined)?.reason;
      if (!reason) return;
      appendEvent({ message: reason }, "message");
    },
    workers: createAiWorkers(config),
  };
}
