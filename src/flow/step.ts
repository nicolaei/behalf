// Flow authoring — Step, PersonaStep, StepContext, Emit. See docs/reference.md § "StepContext".

import type { Message, Usage } from "./message.js";
import type { Profile } from "./profile.js";
import type { Tool } from "./tool.js";
import type { ThreadId, ThreadAction } from "./thread.js";
import type { NodeId } from "./graph.js";
import type { Stream } from "../session/envelope.js";
import type { EventType } from "../session/event.js";

export interface ModelCallResult {
  usedTools: boolean;
  usage: Usage;
}

export interface StepError {
  type: string; // category: "provider" | "tool" | "timeout" | "validation" | …
  message: string;
  retryable?: boolean; // advisory hint from the raiser (e.g. a 429)
  cause?: unknown; // the raw error, for logs
}

/** The one outcome a step returns. Only `output` is routed by edges. */
export type Emit<Result = unknown> =
  | { output: Result }
  | { compact: Message[]; meta?: unknown }
  | { invalidate: NodeId; threadAction: ThreadAction; reason?: Message }
  | { error: StepError };

/** What a step sees and does. */
export interface StepContext {
  readonly thread: {
    id: ThreadId;
    label?: string;
    forkedFrom?: { thread: ThreadId; at: number };
    parentThreadId?: ThreadId;
    messages: Message[]; // the assembled view — compaction applied, tail trimmed
    history: Message[]; // the full record on this thread, including compaction messages
  };
  readonly inputs: unknown[]; // upstream outputs; a join gets one per branch
  openStream(type: EventType): Stream; // open a fresh stream scoped to this step's thread

  modelCall(profile: Profile): Promise<ModelCallResult>; // one request + its tools, appended to the log
  callTool<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output>;

  output<Result>(value: Result): Emit<Result>;
  compact(
    replace: (messages: Message[]) => Promise<Message[]>,
    meta?: unknown,
  ): Promise<Emit<Message[]>>;
  invalidate(
    target: NodeId,
    options?: { threadAction?: ThreadAction; reason?: Message },
  ): Emit<never>;
  fail(error: StepError): Emit<never>;
}

export type Step<Result = unknown> = (context: StepContext) => Promise<Emit<Result>>;

/** A step that uses a model — carries its `persona` so the graph sees it with no separate registration. */
export type PersonaStep<Result = unknown> = Step<Result> & { persona: Profile };

/**
 * A step that computes a value from context and outputs it — for steps with no
 * model call and no async work of their own. Reads better than the raw
 * `(context) => Promise.resolve(context.output(compute(context)))` it wraps.
 */
export function outputs<Result>(compute: (context: StepContext) => Result): Step<Result> {
  return (context) => Promise.resolve(context.output(compute(context)));
}

/**
 * A step that replaces the thread's messages and nothing else — for
 * compaction steps with no async work of their own.
 */
export function compacts(
  replace: (messages: Message[]) => Message[],
  meta?: unknown,
): Step<Message[]> {
  return (context) =>
    Promise.resolve(context.compact((messages) => Promise.resolve(replace(messages)), meta));
}
