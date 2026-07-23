// Flow authoring — Step, PersonaStep, StepContext, Emit. See docs/reference.md § "StepContext".

import type { Message, Usage } from "./message.js";
import type { Profile } from "./profile.js";
import type { Tool } from "./tool.js";
import type { ThreadId, ThreadAction } from "./thread.js";
import type { NodeId } from "./graph.js";
import type { Stream } from "../session/envelope.js";
import type { Event, EventType } from "../session/event.js";

/** Summary of a model call — whether tools were used and token usage. @public */
export interface ModelCallResult {
  usedTools: boolean;
  usage: Usage;
  toolCalls: { correlationId: string; name: string }[]; // requested this turn, in reply order
}

/** A structured error a step can return instead of throwing. @public */
export interface StepError {
  type: string; // category: "provider" | "tool" | "timeout" | "validation" | …
  message: string;
  retryable?: boolean; // advisory hint from the raiser (e.g. a 429)
  cause?: unknown; // the raw error, for logs
}

/**
 * What a `waitFor` node hands downstream once it consumes a matching event — `ok` is always
 * true (routing only reaches here on a match); `result` is whatever the armed `Waitable`'s
 * `match()` produced. For `userInput`, that's the `UserMessage` (also already on the thread);
 * for a signal-based `Waitable`, `result` is the only place its payload is reachable, since a
 * signal is deliberately never folded into `thread.messages`.
 * @public
 */
export interface WaitForResult<T = unknown> {
  ok: true;
  result: T;
}

/** The one outcome a step returns. Only `output` is routed by edges. @public */
export type Emit<Result = unknown> =
  | { output: Result }
  | { compact: Message[]; meta?: unknown }
  | { invalidate: NodeId; threadAction: ThreadAction; reason?: Message }
  | { error: StepError };

/** What a step sees and does. @public */
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
  appendEvent<T extends EventType>(payload: Event[T], type: T): void; // commit a standalone event to this step's own thread

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

/** A function that runs one node in the graph and returns its outcome. @public */
export type Step<Result = unknown> = (context: StepContext) => Promise<Emit<Result>>;

/**
 * A step that uses a model — carries its `persona` so the graph sees it with no separate registration.
 * @public
 */
export type PersonaStep<Result = unknown> = Step<Result> & { persona: Profile };

/**
 * A step that sits at a fan-out join point — declares that it expects to receive
 * every branch's output as one array (its `inputs`).  The engine validates this
 * declaration against the edges wired at the node: a converging-edges node without
 * this tag, or a tagged node that is not a converging point, is a wiring mistake
 * the engine should catch rather than silently misinterpret.
 * @public
 */
export type JoinStep<Result = unknown> = Step<Result> & { join: true };

/**
 * A step that computes a value from context and outputs it — for steps with no
 * model call and no async work of their own. Reads better than the raw
 * `(context) => Promise.resolve(context.output(compute(context)))` it wraps.
 * @public
 */
export function outputs<Result>(compute: (context: StepContext) => Result): Step<Result> {
  return (context) => Promise.resolve(context.output(compute(context)));
}

/**
 * A step that collects every fan-out branch's output from `context.inputs` and
 * computes a single merged result — for join nodes with no async work of their
 * own.  Reads better than the raw
 * `(context) => Promise.resolve(context.output(compute(context)))` it wraps.
 * @public
 */
export function join<Result>(compute: (context: StepContext) => Result): JoinStep<Result> {
  const step = (context: StepContext): Promise<Emit<Result>> =>
    Promise.resolve(context.output(compute(context)));
  (step as JoinStep<Result>).join = true;
  return step as JoinStep<Result>;
}

/**
 * A step that replaces the thread’s messages and nothing else — for
 * compaction steps with no async work of their own.
 * @public
 */
export function compacts(
  replace: (messages: Message[]) => Message[],
  meta?: unknown,
): Step<Message[]> {
  return (context) =>
    Promise.resolve(context.compact((messages) => Promise.resolve(replace(messages)), meta));
}
