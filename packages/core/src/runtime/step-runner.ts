// Step-execution machinery shared by the drive loop and fan-out branches:
// running a step's function, building its StepContext, validating join()
// tagging, and folding the compact/error emits every step-running path
// handles the same way.

// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 7: assemble ai()) commitCompaction takes an ai-shaped Message; removed when compaction moves into ai/.
import type { Message } from "../ai/message.js";
import type { NodeId, Graph } from "../graph/graph.js";
import type { Step, StepContext, Emit, ModelCallResult, StepError } from "../graph/step.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 7: assemble ai()) StepContextConfig.callTool takes a Tool; removed when callTool moves into ai's stepContext hook.
import type { Tool } from "../ai/tool.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 7: assemble ai()) StepContextConfig.modelCall takes a Profile; removed when modelCall moves into ai's stepContext hook.
import type { Profile } from "../ai/profile.js";
import type { Stream } from "../session/envelope.js";
import type { Event, EventType } from "../session/event.js";
import type { Runtime } from "./runtime.js";
import { type ErrorContext, type ErrorDecision, unreachable } from "./errors.js";
import { RetryableError } from "./errors.js";
import { type Thread, StateTracker, withCompaction } from "./routing.js";

/**
 * Bundles the two pieces of per-branching-construct bookkeeping that used to
 * travel as separate `ExecutionContext` fields — the per-node retry counter
 * (`attemptsByNode`) and the `stateChange` dedup tracker (`stateTracker`) —
 * and names the two lifecycle rules a branching construct picks between,
 * replacing the "sometimes pass `ctx.stateTracker`, sometimes construct
 * `new StateTracker()`" pattern that used to live only in comments at each
 * construction site (driveStepEmit's fan-out, fan-out.ts's `runBranch`/
 * `advanceFanOutGroup`, foreach.ts's `advanceForEachGroup`).
 *
 * `fork()` — a branch that gets its OWN new thread (a static fan-out
 * branch, forked off the parent's thread): fresh `stateTracker`, since a
 * `state` declared inside it must not dedupe against the parent thread's
 * already-tracked state — it's genuinely a different thread now. Does NOT
 * fork `attemptsByNode`: a retry budget has never had a forking distinction
 * anywhere in this engine (every branching construct shares one counter per
 * node id), and this refactor preserves that rather than changing it as a
 * side effect.
 *
 * `descend()` — a branch that continues on the SAME (unforked) thread, just
 * a new call/frame scope (a `use` node's subgraph, a `forEach` branch):
 * shares the parent's `stateTracker`, since two such branches (or a branch
 * and the thread it shares) declaring the same `state` must dedupe into one
 * `stateChange` — they're really the same thread's own history.
 */
export class ExecutionScope {
  readonly attemptsByNode: Map<NodeId, number>;
  readonly stateTracker: StateTracker;

  constructor(attemptsByNode: Map<NodeId, number>, stateTracker: StateTracker) {
    this.attemptsByNode = attemptsByNode;
    this.stateTracker = stateTracker;
  }

  /** A fresh root scope — no attempts recorded yet, no state seen yet. */
  static create(): ExecutionScope {
    return new ExecutionScope(new Map(), new StateTracker());
  }

  fork(): ExecutionScope {
    return new ExecutionScope(this.attemptsByNode, new StateTracker());
  }

  descend(): ExecutionScope {
    return new ExecutionScope(this.attemptsByNode, this.stateTracker);
  }
}

/** Everything a step or branch needs to run against: the runtime it calls into, the graph it's routing through, the thread it's advancing, and the `ExecutionScope` (attempts + stateTracker) for this drive scope. The one bundle every drive-loop and fan-out-branch function threads through instead of separate positional parameters. */
export interface ExecutionContext {
  runtime: Runtime;
  flow: Graph;
  thread: Thread;
  scope: ExecutionScope;
}

/**
 * Runs a step, converting an uncaught throw into the same `{ error }` shape
 * as an explicit `context.fail(...)` — the two failure modes share one path.
 */
export async function runStep(run: Step, context: StepContext): Promise<Emit> {
  try {
    return await run(context);
  } catch (cause) {
    return {
      error: {
        type: "unexpected",
        message: cause instanceof Error ? cause.message : String(cause),
        retryable: cause instanceof RetryableError ? cause.retryable : false,
        cause,
      },
    };
  }
}

/** Validates a step's inputs against its join() tagging: a join()-tagged step reached with fewer than two inputs was wired as a plain step; a step reached with two or more inputs (a fan-out's convergence point) but not tagged with join() forgot to declare it. Shared by driveGraph and tick, which each check this the same way right before running a step. */
export function assertJoinTagging(nodeId: NodeId, run: Step, inputs: unknown[]): void {
  if ((run as { join?: boolean }).join === true && inputs.length < 2) {
    throw new Error(
      `node "${nodeId}" is tagged with join() but was reached as a plain step — ` +
        `it must be the convergence point of a fan-out`,
    );
  }
  if ((run as { join?: boolean }).join !== true && inputs.length >= 2) {
    throw new Error(
      `node "${nodeId}" is the convergence point of a fan-out but was not defined with join() — ` +
        `wrap its step with join(...) to declare it expects every branch's output`,
    );
  }
}

/** Appends a compaction event and returns a thread with `messages` derived from it (see `withCompaction`) — never mutates the thread passed in. Shared by the main-loop and branch paths, and by `StepContext.compact` itself, since every path commits a compaction the same way. */
export function commitCompaction(
  runtime: Runtime,
  thread: Thread,
  compaction: Event["compaction"],
): Thread {
  runtime.store.append(compaction, { type: "compaction", threadId: thread.id });
  return withCompaction(thread, compaction);
}

/**
 * Handles a step's `error` emit: logs it, consults the runtime's error
 * handlers, and either decides to retry the node (bumping its attempt count)
 * or throws to fail the whole run. Shared by the main-loop and branch paths
 * since both drive a step's error the same way.
 */
export async function handleStepError(
  emit: Extract<Emit, { error: StepError }>,
  nodeId: NodeId,
  ctx: ExecutionContext,
): Promise<{ kind: "retry" }> {
  const { runtime, thread, scope } = ctx;
  const { attemptsByNode } = scope;
  const threadId = thread.id;
  runtime.store.append(
    {
      type: emit.error.type,
      message: emit.error.message,
      ...(emit.error.retryable !== undefined ? { retryable: emit.error.retryable } : {}),
      ...(emit.error.cause !== undefined ? { cause: emit.error.cause } : {}),
    },
    { type: "error", threadId },
  );

  const attempts = attemptsByNode.get(nodeId) ?? 0;
  const errorContext: ErrorContext = {
    step: { id: nodeId },
    thread: threadId,
    attempts,
    log: runtime.store.events(),
  };

  let resolvedDecision: ErrorDecision | undefined;
  for (const handler of runtime.errorHandlers) {
    resolvedDecision = handler(emit.error, errorContext);
    if (resolvedDecision) break;
  }
  // runtime() always appends defaultErrorHandler last, and it never itself
  // returns undefined, so the loop above always settles on a decision.
  if (resolvedDecision === undefined)
    unreachable("handleStepError: no error handler produced a decision");
  const decision = resolvedDecision;

  if (decision.action === "fail") {
    throw new Error(emit.error.message, { cause: emit.error });
  }

  attemptsByNode.set(nodeId, attempts + 1);
  if (decision.after) await new Promise((resolve) => setTimeout(resolve, decision.after));
  return { kind: "retry" };
}

/** Config that differs between the main-loop StepContext and a fan-out branch's — everything else is shared. */
export interface StepContextConfig {
  getThread: () => Thread;
  inputs: unknown[];
  openStream: (type: EventType) => Stream; // on-demand stream factory model calls and steps use to create a logged event
  appendEvent: <T extends EventType>(payload: Event[T], type: T) => void; // commits a standalone event to this scope's thread
  modelCall: (profile: Profile) => Promise<ModelCallResult>;
  callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) => Promise<Output>;
  compact: (input: { task?: Message; summary: Message; keepLast: number }) => Promise<void>;
}

/**
 * Builds a `StepContext` from whatever differs between where it runs — the
 * main drive loop or a fan-out branch. Both call this one factory so a later
 * change (filling in a branch's `call` stub) touches
 * one place instead of two parallel builders.
 */
export function makeStepContext(config: StepContextConfig): StepContext {
  return {
    get thread() {
      return config.getThread();
    },
    inputs: config.inputs,
    openStream: config.openStream,
    appendEvent: config.appendEvent,
    modelCall: config.modelCall,
    callTool: config.callTool,
    output<Result>(value: Result): Emit<Result> {
      return { output: value };
    },
    compact: config.compact,
    invalidate(target, options): Emit<never> {
      return {
        invalidate: target,
        threadAction: options?.threadAction ?? "same",
        ...(options?.reason ? { reason: options.reason } : {}),
      };
    },
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };
}

/**
 * Derives a `StepContext` that shares everything with `context` except its
 * `inputs` — used everywhere a node needs to rerun the same context with
 * different inputs (an interrupt's own message, a join's per-branch array).
 * `thread` is re-exposed through a delegating getter rather than copied by
 * value: a plain object spread (`{ ...context, inputs }`) would evaluate
 * `context.thread` once at spread time and freeze that snapshot, missing any
 * later replacement (e.g. a model or tool call folding a message in) that
 * happens while the derived context's own step is still running.
 */
export function withInputs(context: StepContext, inputs: unknown[]): StepContext {
  return {
    get thread() {
      return context.thread;
    },
    inputs,
    openStream: (type) => context.openStream(type),
    appendEvent: (payload, type) => {
      context.appendEvent(payload, type);
    },
    modelCall: (profile) => context.modelCall(profile),
    callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) =>
      context.callTool(tool, input),
    output: <Result>(value: Result) => context.output(value),
    compact: (input) => context.compact(input),
    invalidate: (target, options) => context.invalidate(target, options),
    fail: (error) => context.fail(error),
  };
}
