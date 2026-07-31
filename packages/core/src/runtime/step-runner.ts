// Step-execution machinery shared by the drive loop and fan-out branches:
// running a step's function, building its StepContext, validating join()
// tagging, and folding the compact/error emits every step-running path
// handles the same way.

// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): commitCompaction takes an ai-shaped Message/compaction payload; compact stays a built-in StepContext field per this task's own scoping (see task notes).
import type { Message } from "../ai/message.js";
import type { NodeId, Graph } from "../graph/graph.js";
import type { ScopeId, ScopeAction } from "../graph/thread.js";
import type { Step, StepContext, Emit, ModelCallResult, StepError } from "../graph/step.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): StepContextConfig.callTool takes a Tool; kept built-in per this task's own scoping.
import type { Tool } from "../ai/tool.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): StepContextConfig.modelCall takes a Profile; same reasoning as callTool's note above.
import type { Profile } from "../ai/profile.js";
import type { Stream, CommittedEnvelope } from "../session/envelope.js";
import type { Event, EventType } from "../session/event.js";
import type { Runtime } from "./runtime.js";
import {
  type EngineExtension,
  type ExecutionScope as ScopeHandle,
  foldExtensionState,
  makeDeriveScope,
  seedScope,
} from "./extension.js";
import { type ErrorContext, type ErrorDecision, unreachable } from "./errors.js";
import { RetryableError } from "./errors.js";
import { StateTracker } from "./routing.js";

/**
 * The `stateChange` dedup tracker, plus the two lifecycle rules a branching
 * construct picks between — replacing the "sometimes pass `ctx.stateTracker`,
 * sometimes construct `new StateTracker()`" pattern that used to live only in
 * comments at each construction site.
 *
 * `fork()` — a branch that gets its OWN new scope (a static fan-out branch,
 * forked off the parent's scope): fresh `stateTracker`, since a `state`
 * declared inside it must not dedupe against the parent scope's
 * already-tracked state — it's genuinely a different scope now.
 *
 * `descend()` — a branch that continues on the SAME (unforked) scope, just a
 * new call/frame scope (a `use` node's subgraph, a `forEach` branch): shares
 * the parent's `stateTracker`, since two such branches (or a branch and the
 * scope it shares) declaring the same `state` must dedupe into one
 * `stateChange` — they're really the same scope's own history.
 *
 * Retry budgets used to live here too, as an in-memory `attemptsByNode` map.
 * They don't any more: an attempt count is derived from the committed log
 * (see `attemptsSoFar`), the only state that survives between `tick()` calls.
 */
export class ExecutionScope {
  readonly stateTracker: StateTracker;

  constructor(stateTracker: StateTracker) {
    this.stateTracker = stateTracker;
  }

  /** A fresh root scope — no state seen yet. */
  static create(): ExecutionScope {
    return new ExecutionScope(new StateTracker());
  }

  fork(): ExecutionScope {
    return new ExecutionScope(new StateTracker());
  }

  descend(): ExecutionScope {
    return new ExecutionScope(this.stateTracker);
  }
}

/** Everything a step or branch needs to run against: the runtime it calls into, the graph it's routing through, the scope it's advancing, and the `ExecutionScope` (stateTracker) for this drive scope. `branchId` is set only inside a dynamic (`forEach`) branch — see `Envelope.branchId`; it tags this branch's own committed events so replay can tell them from a sibling's while both run on the shared parent scope. */
export interface ExecutionContext {
  runtime: Runtime;
  flow: Graph;
  scope: ScopeId;
  execScope: ExecutionScope;
  branchId?: string;
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

/**
 * How many times node `nodeId` has already errored on `scope`, according to
 * the committed log alone — the retry budget's only durable home.
 *
 * `tick()` rebuilds every scrap of in-memory state on each call by design, so
 * an in-memory attempt counter always read zero and a default retry handler
 * never reached its cap. Every attempt already leaves a durable trace: an
 * `error` event, now tagged with the failing node's own `stepId`. Counting
 * those — for this node, on this scope — is therefore the log-derived
 * definition of "attempts so far", and it agrees across replays, restarts, and
 * fresh `Runtime` objects sharing one store.
 *
 * Counted BEFORE this attempt's own error event is appended, so the first
 * failure reports 0 attempts, exactly as the in-memory counter did.
 */
export function attemptsSoFar(runtime: Runtime, nodeId: NodeId, scope: ScopeId): number {
  let count = 0;
  for (const envelope of runtime.store.events()) {
    if (envelope.form !== "committed") continue;
    if (envelope.type !== "error") continue;
    if (envelope.stepId !== nodeId) continue;
    if (envelope.threadId !== scope) continue;
    count += 1;
  }
  return count;
}

/**
 * Handles a step's `error` emit: logs it (tagged with the failing node, so
 * `attemptsSoFar` can count it later), consults the runtime's error handlers,
 * and either decides to retry the node or throws to fail the whole run.
 */
export async function handleStepError(
  emit: Extract<Emit, { error: StepError }>,
  nodeId: NodeId,
  ctx: ExecutionContext,
): Promise<{ kind: "retry" }> {
  const { runtime, scope } = ctx;
  const attempts = attemptsSoFar(runtime, nodeId, scope);
  runtime.store.append(
    {
      type: emit.error.type,
      message: emit.error.message,
      ...(emit.error.retryable !== undefined ? { retryable: emit.error.retryable } : {}),
      ...(emit.error.cause !== undefined ? { cause: emit.error.cause } : {}),
    },
    { type: "error", threadId: scope, stepId: nodeId },
  );

  const errorContext: ErrorContext = {
    step: { id: nodeId },
    thread: scope,
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

  if (decision.after) await new Promise((resolve) => setTimeout(resolve, decision.after));
  return { kind: "retry" };
}

/** Config that differs between the main-loop StepContext and a fan-out branch's — everything else is shared. */
export interface StepContextConfig {
  runtime: Runtime;
  getScope: () => ScopeId;
  setScope: (scope: ScopeId) => void;
  getLabel?: () => string | undefined;
  inputs: unknown[];
  openStream: (type: EventType) => Stream; // on-demand stream factory model calls and steps use to create a logged event
  appendEvent: <T extends EventType>(payload: Event[T], type: T) => void; // commits a standalone event to this scope
  modelCall: (profile: Profile) => Promise<ModelCallResult>;
  callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) => Promise<Output>;
  compact: (input: { task?: Message; summary: Message; keepLast: number }) => Promise<void>;
  getEvents: () => readonly CommittedEnvelope[]; // this scope's slice of the committed log, backing ExecutionScope.events()
  extensions: EngineExtension[]; // registered extensions whose stepContext() is merged into the built StepContext
}

/** The built-in StepContext field names — reserved so an extension's contributed key can never silently shadow one. */
const BUILT_IN_STEP_CONTEXT_KEYS = [
  "scope",
  "inputs",
  "openStream",
  "appendEvent",
  "modelCall",
  "callTool",
  "output",
  "compact",
  "invalidate",
  "fail",
];

/** Builds the `ExecutionScope` handle passed to each extension's `stepContext(scope)` — `state(name)` folds this scope's events through `name`'s own registered `reducers` (see `foldExtensionState`), independently for every extension name a caller asks for. */
function makeExecutionScope(config: StepContextConfig): ScopeHandle {
  return {
    get scope() {
      return config.getScope();
    },
    events: config.getEvents,
    state(extension: string): unknown {
      return foldExtensionState(
        config.getEvents(),
        config.extensions.find((candidate) => candidate.name === extension),
        config.getScope(),
      );
    },
    appendEvent: config.appendEvent,
    deriveScope: makeDeriveScope(config.runtime, config.getScope, config.setScope),
    ...(config.getLabel ? { label: config.getLabel } : {}),
  };
}

/** Merges every registered extension's `stepContext(scope)` contribution into one object. Throws on a key that collides with a built-in field, or with another extension's contribution — a real ambiguity, never resolved by silent last-writer-wins. */
function mergeExtensionStepContext(
  extensions: EngineExtension[],
  scope: ScopeHandle,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const extension of extensions) {
    if (!extension.stepContext) continue;
    const contributed = extension.stepContext(scope);
    for (const [key, value] of Object.entries(contributed)) {
      if (BUILT_IN_STEP_CONTEXT_KEYS.includes(key)) {
        throw new Error(
          `extension "${extension.name}" contributed stepContext key "${key}", which collides with a built-in StepContext field`,
        );
      }
      if (key in merged) {
        throw new Error(
          `two extensions contributed the same stepContext key "${key}" — ambiguous merge, rename one`,
        );
      }
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Builds a `StepContext` from whatever differs between where it runs — the
 * main drive loop or a fan-out branch. Both call this one factory so a later
 * change (filling in a branch's `call` stub) touches
 * one place instead of two parallel builders.
 *
 * Every registered extension's `stepContext(scope)` contribution is merged in
 * on top of the built-in fields (see `mergeExtensionStepContext`) — this is
 * the one place that happens, so both `buildDriveContext` (drive.ts/tick.ts)
 * and the fan-out branch context (fan-out.ts) get it for free.
 */
export function makeStepContext(config: StepContextConfig): StepContext {
  const scope = makeExecutionScope(config);
  const extensionFields = mergeExtensionStepContext(config.extensions, scope);
  const context = {
    get scope() {
      return config.getScope();
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
    invalidate(target: NodeId, options?: { action?: ScopeAction; payload?: unknown }): Emit<never> {
      return {
        invalidate: target,
        ...(options?.action ? { action: options.action } : {}),
        ...(options?.payload !== undefined ? { payload: options.payload } : {}),
      };
    },
    fail(error: StepError): Emit<never> {
      return { error };
    },
  };
  return Object.assign(context, extensionFields) as unknown as StepContext;
}

/**
 * Derives a `StepContext` that shares everything with `context` except its
 * `inputs` — used everywhere a node needs to rerun the same context with
 * different inputs (an interrupt's own message, a join's per-branch array).
 * `scope` is re-exposed through a delegating getter rather than copied by
 * value, so a later replacement (a scope transition mid-step) is never
 * missed. Any extension-contributed key already merged onto `context` (see
 * `makeStepContext`) carries over too, since it isn't one of the built-in
 * fields explicitly re-mapped below.
 */
export function withInputs(context: StepContext, inputs: unknown[]): StepContext {
  const extensionFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!BUILT_IN_STEP_CONTEXT_KEYS.includes(key)) extensionFields[key] = value;
  }
  const derived = {
    get scope() {
      return context.scope;
    },
    inputs,
    openStream: (type: EventType) => context.openStream(type),
    appendEvent: (payload: Event[EventType], type: EventType) => {
      context.appendEvent(payload, type);
    },
    modelCall: (profile: Profile) => context.modelCall(profile),
    callTool: <Input, Output>(tool: Tool<Input, Output>, input: Input) =>
      context.callTool(tool, input),
    output: <Result>(value: Result) => context.output(value),
    compact: (input: { task?: Message; summary: Message; keepLast: number }) =>
      context.compact(input),
    invalidate: (
      target: Parameters<StepContext["invalidate"]>[0],
      options?: Parameters<StepContext["invalidate"]>[1],
    ) => context.invalidate(target, options),
    fail: (error: StepError) => context.fail(error),
  };
  return Object.assign(derived, extensionFields) as unknown as StepContext;
}

// Re-exported so callers of `context.invalidate`'s payload-seeding side effect
// (drive.ts's `commitInvalidation`, tick.ts's `routeAbort`) reach it through
// the same module they already import extension helpers from.
export { seedScope };
