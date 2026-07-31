// Routing — edge selection and the shared output/route-commit helpers every
// node kind's own routing goes through. Thread/message-fold machinery
// (`withMessage`, `applyThreadAction`, `deriveCompactedMessages`) moved to
// `ai/thread.ts` (B2 step 8, thread extraction) — this file now only ever
// deals in opaque `ScopeId`s; it has no notion of threads, prompts, or
// messages.

import type { NodeId, EdgeDefinition, EdgeContext } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { Runtime } from "./runtime.js";
import type { Event, EventType } from "../session/event.js";
import { isCommittedEnvelope, type CommittedEnvelope } from "../session/envelope.js";
import {
  type EngineExtension,
  type ExecutionScope as ScopeHandle,
  foldExtensionState,
  makeDeriveScope,
} from "./extension.js";

/** A step's identity for logging purposes — its node id, and its declared label, if any. */
export interface StepIdentity {
  stepId: NodeId;
  stepName?: string;
}

/** Builds a StepIdentity from a node id and its optional label — shared by every call site that logs one. */
export function stepIdentity(id: NodeId, label?: string): StepIdentity {
  return { stepId: id, ...(label ? { stepName: label } : {}) };
}

/**
 * Picks the edge a node's output should follow: the first matching `when`,
 * else the `otherwise` edge, else the unconditional `then` edge.
 */
export function selectEdge(
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
): EdgeDefinition | undefined {
  const outgoing = edges.filter((candidate) => candidate.from === from);
  const when = outgoing.find(
    (candidate) => candidate.edge === "when" && candidate.condition?.(output),
  );
  if (when) return when;
  const otherwise = outgoing.find((candidate) => candidate.edge === "otherwise");
  if (otherwise) return otherwise;
  return outgoing.find((candidate) => candidate.edge === "then");
}

/** Follows the node's outgoing edge for the given output, or throws if it has none. */
export function advance(edges: readonly EdgeDefinition[], from: NodeId, output: unknown): NodeId {
  const edge = selectEdge(edges, from, output);
  if (!edge) throw new Error(`node "${from}" has no outgoing edge`);
  return edge.to;
}

/** Appends a node's output event to the log — shared by every path that produces one. `branchId`, when given, attributes it to a dynamic (`forEach`) branch running on the shared parent scope (see `Envelope.branchId`). */
export function appendOutput(
  runtime: Runtime,
  scope: ScopeId,
  output: unknown,
  step: StepIdentity,
  branchId?: string,
): void {
  runtime.store.append(
    { value: output },
    {
      type: "output",
      threadId: scope,
      stepId: step.stepId,
      ...(step.stepName ? { stepName: step.stepName } : {}),
      ...(branchId ? { branchId } : {}),
    },
  );
}

/** Logs a step's output and follows the resulting edge — the shared tail of every node that emits one. */
export function commitOutput(
  runtime: Runtime,
  scope: ScopeId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  step: StepIdentity,
): NodeId {
  appendOutput(runtime, scope, output, step);
  return advance(edges, from, output);
}

/** Where routing a node landed: the (possibly new — an edge's own `run` fn may have called `ctx.thread.start`/`fork`) resulting scope, the value the next node sees, and the next node id. */
export interface RouteResult {
  scope: ScopeId;
  input: unknown;
  to: NodeId;
}

/**
 * Advances from a node's output and follows the resulting edge, in one step — never runs the
 * edge's own `run` function (see `commitRoute`, the one call site that does). Used throughout
 * `tick.ts`'s `replayPosition` to recognize an already-logged event without redoing the work
 * that produced it: the scope a replayed edge lands on is recovered generically, from whichever
 * scope the NEXT committed envelope is tagged with (see `replayPosition`'s own resync), not by
 * re-running anything here.
 */
export function route(
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  scope: ScopeId,
): RouteResult {
  const to = advance(edges, from, output);
  return { scope, input: output, to };
}

/** The built-in `EdgeContext` field names — reserved so an extension's contributed key can never silently shadow one. Mirrors `step-runner.ts`'s `BUILT_IN_STEP_CONTEXT_KEYS`. */
const BUILT_IN_EDGE_CONTEXT_KEYS = ["scope", "appendEvent"];

/** Builds the `ExecutionScope` handle passed to an extension's `edgeContext(scope)` — scoped to a mutable "current scope" cell (`getScope`/`setScope`) so an extension's own `deriveScope("fork" | "new")` call (ai's `ctx.thread.start`/`fork`) can redirect where this SAME edge invocation's subsequent `appendEvent`/`state()` calls land, without ever touching engine state outside this one edge-run call. `state(name)` folds this scope's events through `name`'s own registered `reducers` (see `foldExtensionState`), same as the step-context side. */
function makeEdgeExecutionScope(
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): ScopeHandle {
  const events = (): readonly CommittedEnvelope[] =>
    runtime.store
      .events()
      .filter(isCommittedEnvelope)
      .filter((envelope) => envelope.threadId === getScope());
  return {
    get scope() {
      return getScope();
    },
    events,
    state(extension: string): unknown {
      return foldExtensionState(
        events(),
        runtime.extensions.find((candidate) => candidate.name === extension),
        getScope(),
      );
    },
    appendEvent<T extends EventType>(payload: Event[T], type: T): void {
      runtime.store.append(payload, { type, threadId: getScope() });
    },
    deriveScope: makeDeriveScope(runtime, getScope, setScope),
  };
}

/** Merges every registered extension's `edgeContext(scope)` contribution into one object — the `EdgeContext` analogue of `step-runner.ts`'s `mergeExtensionStepContext`. Throws on a key that collides with a built-in field, or with another extension's contribution, rather than silently picking a last-writer-wins policy. */
function mergeExtensionEdgeContext(
  extensions: EngineExtension[],
  scope: ScopeHandle,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const extension of extensions) {
    if (!extension.edgeContext) continue;
    const contributed = extension.edgeContext(scope);
    for (const [key, value] of Object.entries(contributed)) {
      if (BUILT_IN_EDGE_CONTEXT_KEYS.includes(key)) {
        throw new Error(
          `extension "${extension.name}" contributed edgeContext key "${key}", which collides with a built-in EdgeContext field`,
        );
      }
      if (key in merged) {
        throw new Error(
          `two extensions contributed the same edgeContext key "${key}" — ambiguous merge, rename one`,
        );
      }
      merged[key] = value;
    }
  }
  return merged;
}

/** Builds the `EdgeContext` an edge's `run` function is called with — the built-in `scope`/`appendEvent` fields, plus every registered extension's `edgeContext(scope)` contribution merged on top (see `mergeExtensionEdgeContext`), all scoped to the same mutable "current scope" cell. */
function buildEdgeContext(
  runtime: Runtime,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): EdgeContext {
  const scope = makeEdgeExecutionScope(runtime, getScope, setScope);
  const extensionFields = mergeExtensionEdgeContext(runtime.extensions, scope);
  const context = {
    get scope() {
      return getScope();
    },
    appendEvent: <T extends EventType>(payload: Event[T], type: T) => {
      scope.appendEvent(payload, type);
    },
  };
  return Object.assign(context, extensionFields) as unknown as EdgeContext;
}

/**
 * Runs the followed edge's `run` function, if it has one — exactly once, since this is only
 * ever called from `commitRoute` (the moment a route genuinely commits live), never from the
 * bare `route()` a replay reconstruction uses to recognize an already-logged event without
 * redoing the work that produced it. Returns `{ input: output, scope }` unchanged when the
 * edge carries no `run` — otherwise `input` is the `run` function's own return value, and
 * `scope` is whatever the edge context's mutable cell ended up on (unchanged unless `run`
 * itself called `ctx.thread.start`/`fork`, or any other extension-contributed scope-deriving
 * method).
 */
function runEdgeFn(
  runtime: Runtime,
  scope: ScopeId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
): { input: unknown; scope: ScopeId } {
  const edge = selectEdge(edges, from, output);
  const run = edge?.options?.run;
  if (!run) return { input: output, scope };
  let current = scope;
  const context = buildEdgeContext(
    runtime,
    () => current,
    (next) => {
      current = next;
    },
  );
  const input = run(output, context);
  return { input, scope: current };
}

/**
 * Logs a step's output and routes from it, in one step — `route`, plus the log line
 * `commitOutput` folds in on top of `advance`. This is the ONE call site that fires an edge's
 * `run` function (see `runEdgeFn`): every other path that recovers a route already followed —
 * `route()` alone, used throughout `tick.ts`'s `replayPosition` to recognize an already-logged
 * event without redoing the work that produced it — never runs it again.
 */
export function commitRoute(
  runtime: Runtime,
  scope: ScopeId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  step: StepIdentity,
): RouteResult {
  const to = commitOutput(runtime, scope, edges, from, output, step);
  const followed = runEdgeFn(runtime, scope, edges, from, output);
  return { scope: followed.scope, input: followed.input, to };
}

/**
 * Owns "last state seen per scope" and emits a `stateChange` event when a
 * node's declared `state` differs from it — omitting `from` on that scope's
 * first entry. `maybeEmit` is a no-op when `state` is `undefined`: a node with
 * no declared state is invisible to the state machine, not a silent
 * transition to some "undefined" phase. Shared by every node kind's own
 * check-and-emit — `driveGraph`'s main loop, `runBranchNode`'s fan-out/
 * forEach branches, and the two places an armed `interrupt` wins a race and
 * takes over routing. `maybeEmit`'s optional `step` identity is stamped onto
 * the envelope the same way every other event type carries `stepId`/
 * `stepName` (see `stepIdentity`) — every call site should pass one; it's
 * optional only so a caller with no node identity in scope still compiles.
 * Accepts a seed so a caller that reconstructed prior state from the log
 * (e.g. `tick`'s `replayStateTracker`) can resume from it instead of
 * starting empty.
 */
export class StateTracker {
  private readonly lastState: Map<ScopeId, string>;

  constructor(seed: Iterable<readonly [ScopeId, string]> = []) {
    this.lastState = new Map(seed);
  }

  maybeEmit(
    runtime: Runtime,
    scope: ScopeId,
    state: string | undefined,
    step?: StepIdentity,
  ): void {
    if (state === undefined) return;
    const previous = this.lastState.get(scope);
    if (previous === state) return;
    runtime.store.append(
      { ...(previous !== undefined ? { from: previous } : {}), to: state },
      {
        type: "stateChange",
        threadId: scope,
        ...(step
          ? { stepId: step.stepId, ...(step.stepName ? { stepName: step.stepName } : {}) }
          : {}),
      },
    );
    this.lastState.set(scope, state);
  }
}

/** The `then` edges leaving a node, in declared order — more than one means a fan-out. */
export function thenEdges(edges: readonly EdgeDefinition[], from: NodeId): EdgeDefinition[] {
  return edges.filter((candidate) => candidate.from === from && candidate.edge === "then");
}
