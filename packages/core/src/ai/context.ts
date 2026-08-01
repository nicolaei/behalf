// AI authoring — StepContext/EdgeContext augmentation. See docs/reference.md
// § "The extension seam". Type-only declaration merge: the ai extension
// augments both context types with what it contributes, so flow authors see
// one seamless `StepContext`/`EdgeContext` — the runtime piece that actually
// builds each value lives in ai/extension.ts's `stepContext`/`edgeContext`
// hooks (see ai/thread.ts's `buildThreadContext`, ai/model-call.ts's
// `runModelCall`, and ai/tool-executor.ts's `callTool`).
//
// `modelCall`/`callTool`/`compact` used to be built-in `StepContext` fields.
// They are contributed the same way `thread` already was, which is what makes
// the engine ai-free: nothing under graph/ names a Profile, a Tool, or a
// Message.

import type { ThreadContext } from "./thread.js";
import type { Message } from "./message.js";
import type { Profile } from "./profile.js";
import type { Tool } from "./tool.js";
import type { ModelCallResult } from "./model-call.js";

/** What `ctx.compact` takes: the summary that replaces the compacted span, how many recent messages to keep verbatim, and optionally the task the summary was produced for. @public */
export interface CompactionInput {
  task?: Message;
  summary: Message;
  keepLast: number;
}

declare module "../graph/step.js" {
  interface StepContext {
    thread: ThreadContext;
    /** One request + its tools, appended to the log. */
    modelCall(profile: Profile): Promise<ModelCallResult>;
    callTool<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output>;
    compact(input: CompactionInput): Promise<void>;
  }
}

declare module "../graph/graph.js" {
  interface EdgeContext {
    thread: ThreadContext;
  }
}
