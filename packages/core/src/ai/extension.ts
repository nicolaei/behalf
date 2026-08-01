// The ai extension itself — assembles model calls, the tool executor, the
// message/compaction/threadGenesis reducers, and the `ctx.thread` context
// contribution into one EngineExtension a caller passes via
// runtime({ extensions: [ai({ models, bindings })] }).

import "./context.js"; // side-effect: registers the StepContext/EdgeContext.thread declaration merge
import type { EngineExtension, ExecutionScope, StepExecutionScope } from "../runtime/index.js";
import type { Model } from "./model.js";
import type { ModelPort } from "./model-port.js";
import type { Binding } from "./tool.js";
import type { AgentSpawner } from "./agent-spawner.js";
import type { Message } from "./message.js";
import type { Profile } from "./profile.js";
import type { Tool } from "./tool.js";
import type { CompactionInput } from "./context.js";
import { runModelCall } from "./model-call.js";
import { callTool } from "./tool-executor.js";
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
    stepContext(scope: StepExecutionScope) {
      const thread = buildThreadContext(scope, () => scope.label?.());
      return {
        thread,
        // The three operations that used to be built-in `StepContext` fields.
        // Each is built here, from the engine-generic exposures on `scope`, so
        // nothing under graph/ or runtime/ has to name a Profile, a Tool, or a
        // Message. `scope`'s own getters stay live, which is what keeps a
        // fan-out branch's calls attributed to the BRANCH (its forked scope,
        // its node identity, its branchId) rather than the parent's.
        modelCall: (profile: Profile) => runModelCall(profile, scope, thread),
        callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) =>
          callTool(
            tool,
            input,
            scope.scope,
            scope.runtime,
            scope.identity("callTool called outside a running node"),
          ),
        compact: (input: CompactionInput) => {
          scope.appendEvent(input, "compaction");
          return Promise.resolve();
        },
      };
    },
    edgeContext(scope: ExecutionScope) {
      return { thread: buildThreadContext(scope) };
    },
    seedScope(_scope, payload, appendEvent) {
      const reason = (payload as InvalidatePayload | undefined)?.reason;
      if (!reason) return;
      appendEvent({ message: reason }, "message");
    },
    commitInboxMessage(message, appendEvent) {
      // Core consumed a pending inbox entry at a waitFor/interrupt node and has
      // no event type for it. ai does: its own `"message"`, which
      // `messageReducer` folds straight back onto the thread. The cast is the
      // seam's honest shape — core hands over a bare `{ kind?: string }`,
      // and ai's `UserMessage` is what actually gets received here.
      appendEvent({ message: message as Message }, "message");
    },
    workers: createAiWorkers(config),
  };
}
