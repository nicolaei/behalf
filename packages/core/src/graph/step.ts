// Flow authoring — Step, StepContext, Emit. See docs/reference.md § "StepContext".
//
// Deliberately ai-free (B3.0): nothing here names a Message, a Profile, or a
// Tool. `modelCall`/`callTool`/`compact` are contributed by the ai extension
// through the same `stepContext` seam `thread` already came through — see
// `ai/context.ts`'s declaration merge and `ai/extension.ts`'s hook. The two
// model-call types they used to need (`ModelCallResult`,
// `ModelCallAbortedError`) live in `ai/model-call.ts`, and `PersonaStep` in
// `ai/profile.ts`.

import type { ScopeId, ScopeAction } from "./thread.js";
import type { NodeId } from "./graph.js";
import type { Stream } from "../session/envelope.js";
import type { Event, EventType } from "../session/event.js";

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

/**
 * The one outcome a step returns. Only `output` is routed by edges. `invalidate`'s `action`
 * is core's own minimal, ai-neutral branch-lifecycle decision (`"same" | "fork" | "new"`,
 * default `"same"`); `payload` is a generic extension slot — ai rides its own reason/message
 * shape there to seed whatever scope results, but core never interprets it.
 * @public
 */
export type Emit<Result = unknown> =
  | { output: Result }
  | { invalidate: NodeId; action?: ScopeAction; payload?: unknown }
  | { error: StepError };

/** What a step sees and does. Extensions merge in more (ai: `thread`, `modelCall`, `callTool`, `compact`). @public */
export interface StepContext {
  readonly inputs: unknown[]; // upstream outputs; a join gets one per branch
  readonly scope: ScopeId;
  openStream(type: EventType): Stream; // open a fresh stream scoped to this step's own scope
  appendEvent<T extends EventType>(payload: Event[T], type: T): void; // commit a standalone event to this step's own scope

  output<Result>(value: Result): Emit<Result>;
  invalidate(target: NodeId, options?: { action?: ScopeAction; payload?: unknown }): Emit<never>;
  fail(error: StepError): Emit<never>;
}

/** A function that runs one node in the graph and returns its outcome. @public */
export type Step<Result = unknown> = (context: StepContext) => Promise<Emit<Result>>;

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
