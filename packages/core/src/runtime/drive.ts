// Node-level drive machinery: the pieces `tick()` composes to advance a graph
// one node at a time — the StepContext every step runs with
// (buildDriveContext), the armed-interrupt scan (findInterruptNodes), the
// shared waitFor handling (runWaitForNode/driveWaitForMessage), the emit fold
// (driveStepEmit), and invalidation commits (commitInvalidation). There is no
// blocking drive loop any more: `tick()` is the engine's only driver.

import { type Graph, type NodeId, type NodeKind, nodeOptionFields } from "../graph/graph.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): driveWaitForMessage folds ai-shaped Message/MessageKind/UserMessage; the "message" event's own structural role (a waitFor's own consumption) predates this task and stays out of its scope — see task notes.
import type { UserMessage } from "../ai/message.js";
import type { Waitable } from "../graph/waitable.js";
import type { ScopeId, ScopeAction } from "../graph/thread.js";
import { messageKindOf, tryMessageKindOf } from "../graph/waitable.js";
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
  route,
  commitRoute,
  thenEdges,
} from "./routing.js";
import {
  runStep,
  makeStepContext,
  withInputs,
  handleStepError,
  type ExecutionContext,
} from "./step-runner.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): runModelCall/callTool live in ai/; modelCall/callTool remain built-in StepContext fields per this task's own scoping (see fork-1 decision in task notes) — not yet routed through the generic stepContext extension seam.
import { runModelCall } from "../ai/model-call.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8 follow-up): see runModelCall's import note above; same reasoning for callTool.
import { callTool } from "../ai/tool-executor.js";
import { peekMessageFromInbox, peekSignalMatch, type RaceWinner } from "./execution.js";

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
 * but `output` isn't supported yet" guard), so nothing else from an
 * `ExecutionScope` has meaning here.
 */
export interface WaitContext {
  interrupts: InterruptNode[];
  context: StepContext;
  flow: Graph;
  runtime: Runtime;
  setScope: (scope: ScopeId) => void;
  stateTracker: StateTracker;
  /** Set only inside a dynamic (`forEach`) branch — tags the consumed message with the branch that consumed it. See `Envelope.branchId`. */
  branchId?: string;
}

/**
 * Folds a waitFor node's already-obtained message into the log and
 * routes it: if the message is what an armed `interrupt` was waiting for,
 * that step runs and takes over routing — reading `context.scope` live
 * rather than a local snapshot, so a scope transition its own
 * `context.thread.start`/`fork` (or `context.modelCall()`) made is never
 * dropped — otherwise this node's own edge is followed. Shared by
 * `runWaitForNode` (the one waitFor implementation `tick()` drives every
 * waitFor node through) and fan-out.ts's `runBranchNode`, which resolves a
 * branch's own waitFor message itself and folds it through this same
 * function. Both differ only in how the message is obtained, never in what
 * happens once it's in hand. `ranInterruptStep` reports whether this
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
  runtime.store.append(
    { message },
    {
      type: "message",
      threadId: context.scope,
      ...(wait.branchId ? { branchId: wait.branchId } : {}),
    },
  );

  const interrupt = interrupts.find(
    (candidate) => tryMessageKindOf(candidate.waitable) === message.kind,
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

/**
 * How a waitFor node's own Waitable (and any armed interrupt racing it) gets
 * satisfied. Only one implementation survives — `peekingMessageSource`, which
 * takes a single non-blocking look and reports nothing when nothing is ready
 * yet — but the seam stays named, because "how the winner is obtained" is the
 * one thing a waitFor call site ever varies; everything after that (folding
 * the winning message in, deciding whether it belongs to this node or an armed
 * interrupt, running the interrupt's own step) is `runWaitForNode`'s job.
 */
export interface MessageSource {
  /**
   * Resolves a message-based waitFor node's own race against its armed
   * interrupts — message-based (matched by kind against the pending inbox) and
   * signal-based (matched by their own `match()` against the committed log)
   * alike. Resolves to `undefined` when nothing is ready yet.
   */
  race(waitKind: string, interrupts: readonly InterruptNode[]): Promise<RaceWinner | undefined>;

  /**
   * Resolves a non-message Waitable (e.g. a signal-based one) directly — no
   * interrupt racing on this path. Checks `match()` once (draining at most one
   * pending signal first) and resolves to `undefined` if still unmatched.
   */
  signal<T>(waitable: Waitable<T>, scope: ScopeId): Promise<T | undefined>;
}

/** What a parked `waitFor` reports it is still waiting for: a message-based Waitable contributes its message kind, a signal-based one its own display `label` (see `CursorState.waitingFor`'s note on that overload). */
function waitingForLabel(waitable: Waitable<unknown>): string {
  return tryMessageKindOf(waitable) ?? waitable.label;
}

/**
 * The `MessageSource` `tick()` drives every `waitFor` node through: takes one
 * non-blocking look, never parking this call — the caller reports "parked"
 * itself when this resolves to `undefined`.
 *
 * `race` handles a heterogeneous field the same way the blocking driver used
 * to: message-based candidates (this node's own kind, plus every message-based
 * interrupt's) are peeked out of the pending inbox first; if none is queued,
 * every signal-based interrupt's own `match()` is checked against the
 * committed log — draining at most one pending signal entry, exactly as
 * `peekSignalMatch` does for a signal-based waitFor node. A signal-based
 * interrupt used to make this throw (`messageKindOf` on a Waitable that has no
 * message kind); it is now a first-class candidate winner, so an armed signal
 * interrupt actually fires under `tick()` rather than parking forever.
 */
export function peekingMessageSource(runtime: Runtime): MessageSource {
  return {
    race: (waitKind, interrupts) => {
      const messageInterrupts = interrupts.filter(
        (candidate) => tryMessageKindOf(candidate.waitable) !== undefined,
      );
      const kinds = [
        waitKind,
        ...messageInterrupts.map((interrupt) => messageKindOf(interrupt.waitable)),
      ];
      const message = peekMessageFromInbox(runtime.store, kinds);
      if (message) {
        const interrupt = messageInterrupts.find(
          (candidate) => tryMessageKindOf(candidate.waitable) === message.kind,
        );
        const winner: RaceWinner = interrupt
          ? {
              kind: "interrupt",
              interrupt: { id: interrupt.id, waitable: interrupt.waitable },
              value: message,
            }
          : { kind: "self", message };
        return Promise.resolve(winner);
      }

      for (const interrupt of interrupts) {
        if (tryMessageKindOf(interrupt.waitable) !== undefined) continue;
        const matched = peekSignalMatch(runtime.store, interrupt.waitable);
        if (matched === undefined) continue;
        return Promise.resolve({
          kind: "interrupt",
          interrupt: { id: interrupt.id, waitable: interrupt.waitable },
          value: matched,
        } satisfies RaceWinner);
      }

      return Promise.resolve(undefined);
    },
    signal: (waitable, scope) => Promise.resolve(peekSignalMatch(runtime.store, waitable, scope)),
  };
}

/** What driving a `waitFor` node through a `MessageSource` settled with: routed (with `ranInterruptStep` reporting whether an interrupt's own step ran), or — the peeking variant only — parked, with what it's still waiting for. */
export type WaitForOutcome =
  | ({ kind: "routed" } & RouteResult & { ranInterruptStep: boolean })
  | { kind: "parked"; waitingFor: string[] };

/**
 * Runs a `waitFor` node against the `MessageSource` the caller gives it. A
 * message-based Waitable races `source` against every armed `interrupt` —
 * message-based or signal-based alike — and folds in whichever wins via
 * `driveWaitForMessage` (a message win, whether this node's own or a
 * message-based interrupt's) or the signal-interrupt path below (a
 * signal-based interrupt's own `match()` won instead). Any other provider for
 * this node's own Waitable (e.g. a signal-based one) has no message to fold
 * and no interrupt-arming yet (out of scope for this slice, see waitable.ts);
 * `source.signal` resolves it directly, and its result routes off the
 * `Waitable`'s own `match()` value.
 */
export async function runWaitForNode(
  node: Extract<NodeKind, { kind: "waitFor" }>,
  nodeId: NodeId,
  wait: WaitContext,
  source: MessageSource,
): Promise<WaitForOutcome> {
  const { interrupts, context, flow, runtime, stateTracker } = wait;
  const waitKind = tryMessageKindOf(node.waitable);

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
    const kinds = [waitKind, ...interrupts.map((interrupt) => waitingForLabel(interrupt.waitable))];
    return { kind: "parked", waitingFor: kinds };
  }

  // A message win, whether the waitFor node's own or a message-based
  // interrupt's: both fold through `driveWaitForMessage` identically, so the
  // `UserMessage` to fold is computed once regardless of which of the two
  // actually won the race.
  const wonMessage: UserMessage | undefined =
    winner.kind === "self"
      ? winner.message
      : tryMessageKindOf(winner.interrupt.waitable) !== undefined
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
      ...(nextScope === invalidatedScope ? {} : { from: invalidatedScope }),
      ...(emit.payload !== undefined ? { payload: emit.payload } : {}),
      ...(cause ? { cause } : {}),
    },
    // Tagged with the scope the rerun CONTINUES on, not the one being left
    // behind: replay resyncs its current scope from each envelope's own tag,
    // so a forked rerun with no payload (nothing else ever committed on the
    // minted scope) would otherwise fall straight back onto the old scope and
    // the fork would exist only in the live process. `from` keeps the
    // invalidated scope recorded.
    { type: "invalidation", threadId: nextScope },
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

/** The nodes a step's output can fan out into — more than one `then` edge means a fan-out. `tick()` must detect a fan-out before `driveStepEmit` folds the emit, since it drives one branch per call. */
export function fanOutTargets(flow: Graph, nodeId: NodeId): NodeId[] {
  return thenEdges(flow.edges, nodeId).map((edge) => edge.to);
}

/**
 * Handles the `Emit` a `step` node produced: invalidate, error, or a plain
 * routed output.
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
    unreachable(
      `driveStepEmit: fan-out from "${nodeId}" must be detected by tick before the emit is folded`,
    );
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
 * Builds the `StepContext` every node `tick()` runs executes against:
 * `openStream`/`modelCall`/`callTool` all resolve the currently running node's
 * identity via `currentNodeIdentity`, reading the running node and its scope
 * through getters — `tick` closes over its own loop variables, so this sees
 * the live value on each call.
 */
export function buildDriveContext(
  flow: Graph,
  runtime: Runtime,
  getCurrent: () => NodeId | undefined,
  getScope: () => ScopeId,
  setScope: (scope: ScopeId) => void,
): StepContext {
  const context = makeStepContext({
    runtime,
    getScope,
    setScope,
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
