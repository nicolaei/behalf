// The drive loop: runs a graph node by node from its entry to its `finish`
// node, handling `use`, `waitFor`, invalidate, compact, step errors, and
// fan-out along the way. This is the whole engine loop — shared by the
// top-level runFlow drive and any `use` node's inline subgraph drive — and
// tick()'s own live execution reuses several of its pieces (buildDriveContext,
// findInterruptNodes, driveStepEmit, runWaitForNode, commitInvalidation) to
// drive one node at a time instead of to completion.

import { type Graph, type NodeId, type NodeKind, nodeOptionFields } from "../graph/graph.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): driveWaitForMessage folds ai-shaped Message/MessageKind/UserMessage; the "message" event's own structural role (a waitFor's own consumption) predates this task and stays out of its scope — see task notes.
import type { UserMessage } from "../ai/message.js";
import type { Waitable } from "../graph/waitable.js";
import type { ScopeId, ScopeAction } from "../graph/thread.js";
import { messageKindOf } from "../graph/waitable.js";
import type { Step, StepContext, Emit, ModelCallResult, WaitForResult } from "../graph/step.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): buildDriveContext.callTool takes a Tool; kept built-in per this task's own scoping.
import type { Tool } from "../ai/tool.js";
import { isCommittedEnvelope } from "../session/envelope.js";
import type { Runtime } from "./runtime.js";
import { freshCorrelationId, freshScopeId } from "./ids.js";
import { notImplemented, unreachable } from "./errors.js";
import { seedScope } from "./extension.js";
import {
  type StepIdentity,
  type RouteResult,
  type StateTracker,
  stepIdentity,
  appendOutput,
  route,
  commitRoute,
  thenEdges,
} from "./routing.js";
import {
  runStep,
  makeStepContext,
  withInputs,
  assertJoinTagging,
  handleStepError,
  ExecutionScope,
  type ExecutionContext,
} from "./step-runner.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): runModelCall/callTool live in ai/; modelCall/callTool remain built-in StepContext fields per this task's own scoping (see fork-1 decision in task notes) — not yet routed through the generic stepContext extension seam.
import { runModelCall } from "../ai/model-call.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): see runModelCall's import note above; same reasoning for callTool.
import { callTool } from "../ai/tool-executor.js";
import {
  waitForSignal,
  waitForRace,
  peekMessageFromInbox,
  peekSignalMatch,
  type RaceWinner,
} from "./execution.js";
import { findJoinNode, runBranch, type BranchResult } from "./fan-out.js";

export interface InterruptNode {
  id: NodeId;
  waitable: Waitable<unknown>;
  run: Step;
  label?: string;
  state?: string;
}

/** Every `interrupt` node in the graph — armed for the whole run, not just one node. */
export function findInterruptNodes(flow: Graph): InterruptNode[] {
  const interrupts: InterruptNode[] = [];
  for (const [id, node] of flow.nodes) {
    if (node.kind === "interrupt")
      interrupts.push({
        id,
        waitable: node.waitable,
        run: node.run,
        ...nodeOptionFields(node),
      });
  }
  return interrupts;
}

/** Runs a `use` node: drives its subgraph inline to its own `finish` on the reaching edge's own (unforked) scope, and follows the reaching edge with its result. Any scope transition (`ctx.thread.start`/`fork`, from the ai extension) already happened on the reaching edge's own `run` function, before this node is ever entered — a `use` node itself has no notion of threads, prompts, or messages; it just passes `currentInput` through as the subgraph's own entry input. Descends into `ctx.execScope` (shares its `stateTracker`) rather than forking: a `use` node's subgraph runs on the reaching edge's own scope by default, so a state declared inside it must dedupe against the outer scope's already-tracked state, the same reasoning `driveForEachNode` applies to its branches. */
async function driveUseNode(
  node: Extract<NodeKind, { kind: "use" }>,
  nodeId: NodeId,
  currentInput: unknown,
  ctx: ExecutionContext,
): Promise<RouteResult> {
  const { flow, runtime, execScope } = ctx;

  const result = await driveGraph(
    node.subgraph,
    runtime,
    ctx.scope,
    currentInput,
    execScope.descend(),
  );

  return commitRoute(
    runtime,
    result.scope,
    flow.edges,
    nodeId,
    result.output,
    stepIdentity(nodeId),
  );
}

/**
 * Runs a `forEach` node: computes its items from the prior step's output,
 * builds one branch `Graph` per item via `node.branch` (a dynamic, runtime-
 * sized fan-out — unlike a static `.then([a, b])` fan-out, the branch count
 * and shape aren't known until this node actually runs), drives each branch
 * as a first-class subgraph on the PARENT's own unforked scope — not a
 * forked one, unlike a static fan-out branch — and folds every branch's own
 * result back into an array as this node's single output. Because branches
 * share one real scope, each branch descends into `ctx.execScope` (sharing
 * its `stateTracker`) rather than being given a fresh one per branch: two
 * branches declaring the same `state` must dedupe into one `stateChange`,
 * the same as any other repeat entry on one scope. Branches run
 * concurrently (`Promise.all`), same as a static fan-out's `driveStepEmit`
 * runs its branches (which DO fork, and so DO get an independent tracker
 * each) — but unlike a fork, sharing one scope id means every branch's own
 * `context.thread` reads a live fold of that shared scope's committed log,
 * so a sibling's concurrently-committed message IS visible mid-flight.
 * KNOWN GAP (tracked): pre-B2.8, each branch carried its own in-memory
 * `Thread` value, so siblings' concurrent appends were mutually invisible
 * until the join; post-extraction that value-isolation is gone and
 * concurrent same-scope branches race on live thread reads. See the
 * reported problem "Concurrent forEach branches sharing one scope id race
 * on live thread reads (post-B2.8 thread extraction)" and the two
 * explicitly-skipped cases in foreach-n-branches.test.ts.
 */
async function driveForEachNode(
  node: Extract<NodeKind, { kind: "forEach" }>,
  nodeId: NodeId,
  currentInput: unknown,
  ctx: ExecutionContext,
): Promise<RouteResult> {
  const { flow, runtime, scope, execScope } = ctx;
  const items = node.items(currentInput);
  const results = await Promise.all(
    items.map((item) => driveGraph(node.branch(item), runtime, scope, item, execScope.descend())),
  );
  const outputs = results.map((result) => result.output);

  return commitRoute(runtime, scope, flow.edges, nodeId, outputs, stepIdentity(nodeId));
}

/**
 * The 5 things every `waitFor`/`interrupt` call site always carries
 * together — the armed interrupts, the running `StepContext` (which carries
 * `flow`/`runtime` via closure, but is threaded separately here since
 * `driveWaitForMessage` needs `flow`/`runtime` directly, not just through
 * `context`), the scope setter, and the shared state tracker. Bundled so
 * `driveWaitForMessage`/`runWaitForNode` take one argument instead of five
 * positional ones that always travel together.
 *
 * Carries a bare `StateTracker`, not a full `ExecutionScope`: an interrupt's
 * own step can't retry yet (see `driveWaitForMessage`'s "emitting anything
 * but `output` isn't supported yet" guard), so `attemptsByNode` has no
 * meaning here — bundling one would just be a dead field on every call site.
 */
export interface WaitContext {
  interrupts: InterruptNode[];
  context: StepContext;
  flow: Graph;
  runtime: Runtime;
  setScope: (scope: ScopeId) => void;
  stateTracker: StateTracker;
}

/**
 * Folds a waitFor node's already-obtained message into the log and
 * routes it: if the message is what an armed `interrupt` was waiting for,
 * that step runs and takes over routing — reading `context.scope` live
 * rather than a local snapshot, so a scope transition its own
 * `context.thread.start`/`fork` (or `context.modelCall()`) made is never
 * dropped — otherwise this node's own edge is followed. Shared by
 * `runWaitForNode` (the one waitFor implementation both `driveGraph` and
 * `tick()` drive through, parameterized by which `MessageSource` obtained the
 * message — blocking, for `driveGraph`; peeking, for `tick()`) and
 * fan-out.ts's `runBranchNode`, which resolves a branch's own waitFor message
 * itself (block or peek, by its own `waitMode`) and folds it through this
 * same function. All three differ only in how the message is obtained, never
 * in what happens once it's in hand. `ranInterruptStep` reports whether this
 * call actually ran a step (the interrupt) or just consumed a message for
 * free, so tick() can decide whether this counts toward its one-step-per-call
 * budget.
 */
export async function driveWaitForMessage(
  message: UserMessage,
  nodeId: NodeId,
  wait: WaitContext,
): Promise<RouteResult & { ranInterruptStep: boolean }> {
  const { interrupts, context, flow, runtime, stateTracker } = wait;
  // Consuming the message is the same step regardless of who it's for: it
  // becomes a log event and joins the scope's own history, then whichever
  // node was actually armed for its kind — the interrupt, or this waitFor
  // itself — runs and takes over routing.
  runtime.store.append({ message }, { type: "message", threadId: context.scope });

  const interrupt = interrupts.find(
    (candidate) => tryMessageKindOfInterrupt(candidate.waitable) === message.kind,
  );
  if (interrupt) {
    stateTracker.maybeEmit(
      runtime,
      context.scope,
      interrupt.state,
      stepIdentity(interrupt.id, interrupt.label),
    );
    const stepContext: StepContext = withInputs(context, [message]);

    const emit = await runStep(interrupt.run, stepContext);
    // An interrupt step emitting anything but `output` isn't supported yet.
    if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
    // Read the scope back live rather than the local snapshot above: if
    // the interrupt step called `context.modelCall()` or `context.thread.start`/
    // `fork`, the scope may have moved, and a stale local value would
    // silently misattribute the next commit.
    const liveScope = context.scope;
    return {
      ...commitRoute(
        runtime,
        liveScope,
        flow.edges,
        interrupt.id,
        emit.output,
        stepIdentity(interrupt.id, interrupt.label),
      ),
      ranInterruptStep: true,
    };
  }

  const waitForResult: WaitForResult = { ok: true, result: message };
  const routed = route(flow.edges, nodeId, waitForResult, context.scope);
  return {
    ...routed,
    input: waitForResult,
    ranInterruptStep: false,
  };
}

// Mirrors graph/waitable.ts's tryMessageKindOf — re-declared locally to avoid
// a second import; kept name-distinct to avoid shadowing confusion at call sites.
function tryMessageKindOfInterrupt(waitable: Waitable<unknown>): string | undefined {
  return waitable.provider === "userInput" ? waitable.label : undefined;
}

/**
 * How a waitFor node's own Waitable (and any armed interrupt racing it) gets
 * satisfied — the ONE real behavioral difference between `driveGraph` (which
 * blocks until satisfied) and `tick()` (which peeks once, non-blockingly, and
 * reports "parked" if nothing's ready yet, returning control to its caller
 * instead of waiting). Everything else about handling a waitFor node —
 * folding the winning message in, deciding whether it belongs to this node or
 * an armed interrupt, running the interrupt's own step — is identical
 * regardless of which `MessageSource` is in play; see `runWaitForNode`, the
 * one shared implementation both `driveGraph` and `tick()` drive through now,
 * replacing what used to be two separately-written waitFor handlers.
 */
export interface MessageSource {
  /**
   * Resolves a message-based waitFor node's own race against its armed
   * interrupts. The blocking variant awaits `waitForRace` (which also races
   * every signal-based interrupt, alongside the message-based ones). The
   * peeking variant only checks the pending inbox for a message of
   * `waitKind` or a message-based interrupt's own kind — mirroring tick()'s
   * pre-existing contract exactly, asymmetry included: it never considers a
   * signal-based interrupt a candidate winner on this path, so (like tick()
   * always has) it throws via `messageKindOf` if any armed interrupt isn't
   * message-based. Resolves to `undefined` only from the peeking variant,
   * when nothing is ready yet.
   */
  race(waitKind: string, interrupts: readonly InterruptNode[]): Promise<RaceWinner | undefined>;

  /**
   * Resolves a non-message Waitable (e.g. a signal-based one) directly — no
   * interrupt racing on this path either way, matching both existing
   * implementations. The blocking variant awaits `waitForSignal`; the
   * peeking variant checks `match()` once (draining at most one pending
   * signal first) and resolves to `undefined` if still unmatched.
   */
  signal<T>(waitable: Waitable<T>, scope: ScopeId): Promise<T | undefined>;
}

/** The `MessageSource` `driveGraph` drives every `waitFor` node through: blocks until its Waitable (or an armed interrupt's) is satisfied, via `waitForRace`/`waitForSignal`. */
export function blockingMessageSource(runtime: Runtime): MessageSource {
  return {
    race: (waitKind, interrupts) =>
      waitForRace(
        runtime.store,
        waitKind,
        interrupts.map((interrupt) => ({
          id: interrupt.id,
          waitable: interrupt.waitable,
          messageKind: tryMessageKindOfInterrupt(interrupt.waitable),
        })),
      ),
    signal: (waitable, scope) => waitForSignal(runtime.store, waitable, scope),
  };
}

/** The `MessageSource` `tick()` drives every `waitFor` node through: takes one non-blocking look via `peekMessageFromInbox`/`peekSignalMatch`, never parking this call — the caller reports "parked" itself when this resolves to `undefined`. */
export function peekingMessageSource(runtime: Runtime): MessageSource {
  return {
    race: (waitKind, interrupts) => {
      const kinds = [waitKind, ...interrupts.map((interrupt) => messageKindOf(interrupt.waitable))];
      const message = peekMessageFromInbox(runtime.store, kinds);
      if (!message) return Promise.resolve(undefined);
      const interrupt = interrupts.find(
        (candidate) => tryMessageKindOfInterrupt(candidate.waitable) === message.kind,
      );
      const winner: RaceWinner = interrupt
        ? {
            kind: "interrupt",
            interrupt: { id: interrupt.id, waitable: interrupt.waitable },
            value: message,
          }
        : { kind: "self", message };
      return Promise.resolve(winner);
    },
    signal: (waitable, scope) => Promise.resolve(peekSignalMatch(runtime.store, waitable, scope)),
  };
}

/** What driving a `waitFor` node through a `MessageSource` settled with: routed (with `ranInterruptStep` reporting whether an interrupt's own step ran), or — the peeking variant only — parked, with what it's still waiting for. */
export type WaitForOutcome =
  | ({ kind: "routed" } & RouteResult & { ranInterruptStep: boolean })
  | { kind: "parked"; waitingFor: string[] };

/**
 * Runs a `waitFor` node against whichever `MessageSource` the caller gives
 * it — the one shared implementation `driveGraph` and `tick()` both drive
 * every `waitFor` node through now. A message-based Waitable races `source`
 * against every armed `interrupt` — message-based or signal-based alike —
 * and folds in whichever wins via `driveWaitForMessage` (a message win,
 * whether this node's own or a message-based interrupt's) or the
 * signal-interrupt path below (a signal-based interrupt's own `match()` won
 * instead — reachable only through a blocking `source`, since the peeking
 * one never classifies a winner that way, matching tick()'s pre-existing
 * scope). Any other provider for this node's own Waitable (e.g. a
 * signal-based one) has no message to fold and no interrupt-arming yet (out
 * of scope for this slice, see waitable.ts); `source.signal` resolves it
 * directly, and its result routes off the `Waitable`'s own `match()` value.
 */
export async function runWaitForNode(
  node: Extract<NodeKind, { kind: "waitFor" }>,
  nodeId: NodeId,
  wait: WaitContext,
  source: MessageSource,
): Promise<WaitForOutcome> {
  const { interrupts, context, flow, runtime, stateTracker } = wait;
  const waitKind = tryMessageKindOfInterrupt(node.waitable);

  if (waitKind === undefined) {
    const matched = await source.signal(node.waitable, context.scope);
    if (matched === undefined) return { kind: "parked", waitingFor: [node.waitable.label] };
    const routed = route(
      flow.edges,
      nodeId,
      { ok: true, result: matched } satisfies WaitForResult,
      context.scope,
    );
    return { kind: "routed", ...routed, ranInterruptStep: false };
  }

  const winner = await source.race(waitKind, interrupts);
  if (winner === undefined) {
    const kinds = [waitKind, ...interrupts.map((interrupt) => messageKindOf(interrupt.waitable))];
    return { kind: "parked", waitingFor: kinds };
  }

  // A message win, whether the waitFor node's own or a message-based
  // interrupt's: both fold through `driveWaitForMessage` identically, so the
  // `UserMessage` to fold is computed once regardless of which of the two
  // actually won the race.
  const wonMessage: UserMessage | undefined =
    winner.kind === "self"
      ? winner.message
      : tryMessageKindOfInterrupt(winner.interrupt.waitable) !== undefined
        ? (winner.value as UserMessage)
        : undefined;

  if (wonMessage !== undefined) {
    const routed = await driveWaitForMessage(wonMessage, nodeId, wait);
    return {
      kind: "routed",
      scope: routed.scope,
      input: routed.input,
      to: routed.to,
      ranInterruptStep: routed.ranInterruptStep,
    };
  }

  // A signal-based interrupt won: there's no message to fold — same as
  // `source.signal`'s own path — so its step runs with the Waitable's
  // `match()` result as its only input, and its output routes exactly like
  // a message-based interrupt's does in `driveWaitForMessage`.
  if (winner.kind !== "interrupt")
    unreachable("runWaitForNode: a non-message race winner must be an interrupt");
  const interrupt = interrupts.find((candidate) => candidate.id === winner.interrupt.id);
  if (!interrupt) unreachable(`waitForRace resolved to unknown interrupt "${winner.interrupt.id}"`);
  stateTracker.maybeEmit(
    runtime,
    context.scope,
    interrupt.state,
    stepIdentity(interrupt.id, interrupt.label),
  );
  const stepContext: StepContext = withInputs(context, [winner.value]);
  const emit = await runStep(interrupt.run, stepContext);
  if (!("output" in emit)) notImplemented(`emit "${Object.keys(emit).join(", ")}"`);
  const liveScope = context.scope;
  const routed = commitRoute(
    runtime,
    liveScope,
    flow.edges,
    interrupt.id,
    emit.output,
    stepIdentity(interrupt.id, interrupt.label),
  );
  return { kind: "routed", ...routed, ranInterruptStep: true };
}

/** What handling a step's `Emit` decided: retry the same node, or advance to the next one. */
type StepOutcome =
  { kind: "retry" } | ({ kind: "advance" } & RouteResult & { pendingInputs?: unknown[] });

/** Appends an invalidation event and returns the outcome that reruns the invalidated node — shared by the main-loop and branch paths since both commit an `invalidate` emit the same way, and by tick()'s own graph-level abort routing (see `routeAbort`), which synthesizes the same `{ invalidate, action: "same" }` outcome an aborted step's own `context.invalidate(...)` would have produced. `action` is core's own minimal, ai-neutral scope-lifecycle decision (`"same" | "fork" | "new"`, default `"same"`) — a fresh scope is minted the same deterministic way `context.thread.start`/`fork` mints one. `payload` is a generic extension slot never interpreted by core itself: once the resulting scope is settled, every registered extension's own `seedScope` hook (see extension.ts) gets a chance to seed it (ai's own hook folds `payload.reason`, if present, onto that scope the same way `ctx.thread.say` would). `cause: "abort"`, passed only by `routeAbort`, tags the logged event so replay knows to re-derive the target from its own `flow.onAbort` rather than trusting the logged node id — see the `Event["invalidation"]` and `applyInvalidationEvent` doc comments for why that distinction exists. */
export function commitInvalidation(
  runtime: Runtime,
  scope: ScopeId,
  emit: Extract<Emit, { invalidate: NodeId }>,
  cause?: "abort",
): StepOutcome {
  const invalidatedScope = scope;
  const action: ScopeAction = emit.action ?? "same";
  const nextScope = action === "same" ? scope : freshScopeId(runtime);
  runtime.store.append(
    {
      target: emit.invalidate,
      ...(emit.action ? { action: emit.action } : {}),
      ...(emit.payload !== undefined ? { payload: emit.payload } : {}),
      ...(cause ? { cause } : {}),
    },
    { type: "invalidation", threadId: invalidatedScope },
  );
  seedScope(runtime.extensions, nextScope, emit.payload, (payload, type) => {
    runtime.store.append(payload, { type, threadId: nextScope });
  });
  return {
    kind: "advance",
    scope: nextScope,
    input: undefined,
    to: emit.invalidate,
  };
}

/** The nodes a step's output can fan out into — more than one `then` edge means a fan-out. Shared by `driveStepEmit` (which runs every branch to completion) and tick() (which must detect a fan-out before `driveStepEmit` runs, since it drives one branch per call instead of `Promise.all`). */
export function fanOutTargets(flow: Graph, nodeId: NodeId): NodeId[] {
  return thenEdges(flow.edges, nodeId).map((edge) => edge.to);
}

/**
 * Handles the `Emit` a `step` node produced: invalidate, error, a
 * fan-out (more than one `then` edge), or a plain routed output. Each case
 * decides the next node and, for fan-out, the per-branch inputs the join
 * node receives.
 */
export async function driveStepEmit(
  emit: Emit,
  node: Extract<NodeKind, { kind: "step" }>,
  nodeId: NodeId,
  ctx: ExecutionContext,
): Promise<StepOutcome> {
  const { scope, flow, runtime } = ctx;
  if ("invalidate" in emit) {
    return commitInvalidation(runtime, scope, emit);
  }

  if ("error" in emit) {
    return handleStepError(emit, nodeId, ctx);
  }

  // Emit's variants are exactly invalidate/error/output — having ruled out
  // the first two, only "output" remains; anything else is a bug.
  if (!("output" in emit)) unreachable(`emit "${Object.keys(emit).join(", ")}"`);

  const branchTargets: NodeId[] = fanOutTargets(flow, nodeId);
  if (branchTargets.length > 1) {
    appendOutput(runtime, scope, emit.output, stepIdentity(nodeId, node.label));
    // Resolve the convergence node before spawning branches — findJoinNode
    // validates linearity (no nested fan-out) and that all branches share a
    // single common join, replacing the old per-branch joinEdge lookup.
    const joinNodeId = findJoinNode(branchTargets, nodeId, flow);
    const results: BranchResult[] = await Promise.all(
      branchTargets.map((branch: NodeId) =>
        runBranch(branch, emit.output, joinNodeId, {
          ...ctx,
          scope: freshScopeId(runtime),
          // Each fan-out branch forks its own scope, so it gets its own
          // fresh stateChange tracker rather than sharing the parent's.
          execScope: ctx.execScope.fork(),
        }),
      ),
    );

    // A branch that invalidated a node instead of joining means the fan-out
    // step itself must be rerun — same as the main-loop's own invalidate
    // handling, using the pre-fork scope so the rerun lands back on the
    // shared line, not any one branch's forked copy.
    const invalidated = results.find(
      (result): result is Extract<BranchResult, { kind: "invalidate" }> =>
        result.kind === "invalidate",
    );
    if (invalidated) return commitInvalidation(runtime, scope, invalidated.emit);

    const outputs = results.filter(
      (result): result is Extract<BranchResult, { kind: "output" }> => result.kind === "output",
    );
    if (!outputs.length) throw new Error(`fan-out from "${nodeId}" produced no branches`);
    // findJoinNode already ensured all branches converge on joinNodeId.
    return {
      kind: "advance",
      scope,
      input: undefined,
      pendingInputs: outputs.map((result) => result.output),
      to: joinNodeId,
    };
  }

  return {
    kind: "advance",
    ...commitRoute(
      runtime,
      scope,
      flow.edges,
      nodeId,
      emit.output,
      stepIdentity(nodeId, node.label),
    ),
  };
}

/** What driving a graph to its `finish` node settled with — the final scope and the terminal value. */
interface DriveResult {
  scope: ScopeId;
  output: unknown;
}

/** Guards that a node is currently running (`current` is set) and looks up its identity — shared by `driveGraph`'s `openStream` and `modelCall`, whose "no running node" guards differ only in their error message. */
function currentNodeIdentity(
  current: NodeId | undefined,
  flow: Graph,
  errorMessage: string,
): StepIdentity {
  if (!current) throw new Error(errorMessage);
  const node = flow.nodes.get(current);
  const label = node?.kind === "step" ? node.label : undefined;
  return stepIdentity(current, label);
}

/**
 * Builds the drive-loop `StepContext` shared by `driveGraph` and `tick`:
 * `openStream`/`modelCall`/`callTool` all resolve the currently running
 * node's identity via `currentNodeIdentity`, reading the running node and
 * its scope through getters — `driveGraph` closes over its `current`/
 * `currentScope` outer variables, `tick` closes over its own same-named
 * loop variables, and either way this sees the live value on each call.
 */
export function buildDriveContext(
  flow: Graph,
  runtime: Runtime,
  getCurrent: () => NodeId | undefined,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
  parentScope?: ScopeId,
): StepContext {
  const context = makeStepContext({
    runtime,
    getScope,
    setScope,
    ...(parentScope ? { parentScope } : {}),
    getLabel: () => {
      const current = getCurrent();
      const node = current ? flow.nodes.get(current) : undefined;
      return node?.kind === "step" ? node.label : undefined;
    },
    inputs: [],
    getEvents: () => {
      const scope = getScope();
      return runtime.store
        .events()
        .filter(isCommittedEnvelope)
        .filter((envelope) => envelope.threadId === scope);
    },
    extensions: runtime.extensions,
    openStream: (type) => {
      const identity = currentNodeIdentity(
        getCurrent(),
        flow,
        "openStream called outside a running node",
      );
      return runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId: getScope(),
        ...identity,
      });
    },
    appendEvent: (payload, type) => {
      runtime.store.append(payload, { type, threadId: getScope() });
    },
    modelCall(profile): Promise<ModelCallResult> {
      // modelCall only ever runs while a node is being processed by the
      // caller's drive loop, so getCurrent() is always set at that point. The
      // identity itself is only needed for the guard's own error message —
      // runModelCall no longer runs a tool call inline, so it has no need to
      // attribute one to this node's identity.
      if (!getCurrent()) throw new Error("modelCall called outside a running node");
      return runModelCall(profile, context, runtime, setScope);
    },
    callTool<Input, Output>(tool: Tool<Input, Output>, input: Input): Promise<Output> {
      const identity = currentNodeIdentity(
        getCurrent(),
        flow,
        "callTool called outside a running node",
      );
      return callTool(tool, input, getScope(), runtime, identity);
    },
    compact(input): Promise<void> {
      const scope = getScope();
      runtime.store.append(input, { type: "compaction", threadId: scope });
      return Promise.resolve();
    },
  });
  return context;
}

/**
 * Drives one graph from its entry node to its `finish` node: runs each step,
 * follows the edge its output selects, mutates the scope as edges and
 * emits dictate, and handles `waitFor`, `interrupt`, `invalidate`, `compact`,
 * and step errors along the way. This is the whole engine loop, factored out
 * so a `use` node can point the same machinery at a subgraph, inline — same
 * scope, same runtime, same log — and resume the outer drive with the
 * subgraph's result once it reaches its own `finish`.
 *
 * `input` is the value the entry node sees, exactly like `initialPrompt` at
 * the top level: usually a `Message` (the flow's or the subgraph's seed), but
 * any node reachable as an entry may read it via `context.inputs[0]`.
 *
 * `execScope` bundles the caller's `stateTracker` (see `ExecutionScope`) — a
 * `use` node's subgraph and a `forEach` branch both `descend()` into their
 * caller's own scope so their state dedupes against it. `attemptsByNode`,
 * however, is always fresh here regardless of what `execScope` carries: it's
 * scoped to this one call's own `while` loop and discarded when it returns —
 * a "retry" outcome always re-enters this SAME loop via `continue`, never
 * needing to survive past it, so a recursive `driveGraph` call (a `use`
 * subgraph, a `forEach` branch) never needs its caller's own attempt counts.
 */
export async function driveGraph(
  flow: Graph,
  runtime: Runtime,
  scope: ScopeId,
  input: unknown,
  execScope: ExecutionScope = ExecutionScope.create(),
  parentScope?: ScopeId,
): Promise<DriveResult> {
  // The live current scope — reassigned (not mutated) by `invalidate`, a
  // `use` node, or a scope transition when it forks or resets. `context.scope`
  // reads it through a getter so every consumer (modelCall, tool calls,
  // invalidate itself) sees the same, up-to-date scope rather than a
  // snapshot captured once at the top.
  let currentScope: ScopeId = scope;

  let current: NodeId | undefined = flow.entry;
  const context = buildDriveContext(
    flow,
    runtime,
    () => current,
    () => currentScope,
    (next) => {
      currentScope = next;
    },
    parentScope,
  );

  const interrupts = findInterruptNodes(flow);
  let currentInput: unknown = input;
  // Set only when the previous step joined a fan-out group — one entry per
  // branch, in declared order — so the next step's `inputs` isn't wrapped a
  // second time around a single `input`.
  let pendingInputs: unknown[] | undefined;
  // See this function's own doc comment: always fresh, never inherited from
  // `execScope`, regardless of caller.
  const localScope = new ExecutionScope(new Map<NodeId, number>(), execScope.stateTracker);
  const messageSource = blockingMessageSource(runtime);

  while (current) {
    const node = flow.nodes.get(current);
    if (!node) throw new Error(`graph "${flow.name}" has no node "${current}"`);

    // A state-less node is invisible to the state machine; a declared
    // `state` fires (or not) exactly once per node visit here, before
    // dispatching to this node's own kind-specific handling below — so a
    // retried step (which re-enters this loop without changing `current`)
    // re-checks the same already-seen state and stays a no-op.
    localScope.stateTracker.maybeEmit(
      runtime,
      currentScope,
      node.state,
      stepIdentity(current, node.label),
    );
    // Consumed by whichever node runs next, regardless of its kind — a join's
    // pendingInputs must never survive past the node it was meant for.
    const inputs = pendingInputs ?? [currentInput];
    pendingInputs = undefined;

    if (node.kind === "finish") return { scope: currentScope, output: currentInput };

    if (node.kind === "use") {
      const routed = await driveUseNode(node, current, currentInput, {
        flow,
        runtime,
        scope: currentScope,
        execScope: localScope,
      });
      currentScope = routed.scope;
      currentInput = routed.input;
      current = routed.to;
      continue;
    }

    if (node.kind === "forEach") {
      const routed = await driveForEachNode(node, current, currentInput, {
        flow,
        runtime,
        scope: currentScope,
        execScope: localScope,
      });
      currentScope = routed.scope;
      currentInput = routed.input;
      current = routed.to;
      continue;
    }

    if (node.kind === "waitFor") {
      const outcome = await runWaitForNode(
        node,
        current,
        {
          interrupts,
          context,
          flow,
          runtime,
          setScope: (next) => {
            currentScope = next;
          },
          stateTracker: localScope.stateTracker,
        },
        messageSource,
      );
      // The blocking MessageSource (see `blockingMessageSource`) never
      // resolves to "parked" — it awaits until satisfied — so this can only
      // ever be reached by a genuine bug in that contract.
      if (outcome.kind === "parked")
        unreachable("driveGraph: blockingMessageSource reported parked");
      currentScope = outcome.scope;
      currentInput = outcome.input;
      current = outcome.to;
      continue;
    }

    // The only remaining declared kind is "interrupt", which is never a
    // routing target — it's only ever entered via `runWaitForNode` above.
    if (node.kind !== "step") notImplemented(`node kind "${node.kind}"`);

    // Validate JoinStep tagging: a join()-tagged step must receive multiple
    // inputs (from fan-out pendingInputs); see assertJoinTagging.
    assertJoinTagging(current, node.run, inputs);

    const stepContext: StepContext = withInputs(context, inputs);
    const emit = await runStep(node.run, stepContext);

    const outcome = await driveStepEmit(emit, node, current, {
      flow,
      runtime,
      scope: currentScope,
      execScope: localScope,
    });
    if (outcome.kind === "retry") continue;

    currentScope = outcome.scope;
    currentInput = outcome.input;
    pendingInputs = outcome.pendingInputs;
    current = outcome.to;
  }

  return { scope: currentScope, output: currentInput };
}
