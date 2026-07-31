// Routing — edge selection, thread-action application, and the shared
// output/route-commit helpers every node kind's own routing goes through.

// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 8: thread extraction) withMessage/deriveCompactedMessages fold ai-shaped Message; removed when thread folding moves into ai's reducers.
import type { Message } from "../ai/message.js";
import type { NodeId, EdgeDefinition } from "../graph/graph.js";
import type { ThreadAction, ThreadId } from "../graph/thread.js";
import type { StepContext } from "../graph/step.js";
import type { Runtime } from "./runtime.js";
import type { Event } from "../session/event.js";
import { freshThreadId } from "./ids.js";

export type Thread = StepContext["thread"];

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

/** Where a followed edge leads, the thread action it carries, and the reason message (if any) that seeds a new thread. */
export interface Advance {
  to: NodeId;
  threadAction: ThreadAction;
  reason?: Message;
}

/** Follows the node's outgoing edge for the given output, or throws if it has none. */
export function advance(edges: readonly EdgeDefinition[], from: NodeId, output: unknown): Advance {
  const edge = selectEdge(edges, from, output);
  if (!edge) throw new Error(`node "${from}" has no outgoing edge`);
  const reason = edge.options?.prompt?.(output);
  return {
    to: edge.to,
    threadAction: edge.options?.threadAction ?? "same",
    ...(reason ? { reason } : {}),
  };
}

/** Appends a node's output event to the log — shared by every path that produces one. */
export function appendOutput(
  runtime: Runtime,
  threadId: ThreadId,
  output: unknown,
  step: StepIdentity,
): void {
  runtime.store.append(
    { value: output },
    {
      type: "output",
      threadId,
      stepId: step.stepId,
      ...(step.stepName ? { stepName: step.stepName } : {}),
    },
  );
}

/** Logs a step's output and follows the resulting edge — the shared tail of every node that emits one. */
export function commitOutput(
  runtime: Runtime,
  threadId: ThreadId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  step: StepIdentity,
): Advance {
  appendOutput(runtime, threadId, output, step);
  return advance(edges, from, output);
}

/** Applies an edge's threadAction and reports where it leads — the shared tail of following any edge. */
function follow(edge: Advance, thread: Thread, runtime: Runtime): { thread: Thread; to: NodeId } {
  return {
    thread: applyThreadAction(thread, edge.threadAction, edge.reason, runtime),
    to: edge.to,
  };
}

/** Where routing a node landed: the (possibly new) thread, the value the next node sees, its seed reason, and the next node id. */
export interface RouteResult {
  thread: Thread;
  input: unknown;
  reason: Message | undefined;
  to: NodeId;
}

/** Advances from a node's output and follows the resulting edge, in one step — the combining query every call site that never uses `advance`'s result for anything but an immediate `follow` was writing out by hand. */
export function route(
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  thread: Thread,
  runtime: Runtime,
): RouteResult {
  const edge = advance(edges, from, output);
  const followed = follow(edge, thread, runtime);
  return { thread: followed.thread, input: output, reason: edge.reason, to: followed.to };
}

/** Logs a step's output and routes from it, in one step — `route`, plus the log line `commitOutput` folds in on top of `advance`. */
export function commitRoute(
  runtime: Runtime,
  threadId: ThreadId,
  edges: readonly EdgeDefinition[],
  from: NodeId,
  output: unknown,
  step: StepIdentity,
  thread: Thread,
): RouteResult {
  const edge = commitOutput(runtime, threadId, edges, from, output, step);
  const followed = follow(edge, thread, runtime);
  return { thread: followed.thread, input: output, reason: edge.reason, to: followed.to };
}

/** Returns a new thread with `message` appended to both its assembled view and its full history — never mutates the thread passed in. The shared tail of every path that folds one in. */
export function withMessage(thread: Thread, message: Message): Thread {
  return {
    ...thread,
    messages: [...thread.messages, message],
    history: [...thread.history, message],
  };
}

/**
 * Derives the `messages` a `"compaction"` event produces, given the thread's
 * own `history` up to that point: an optional restated `task`, the
 * synthesized `summary`, then the last `keepLast` messages pulled straight
 * out of `history` — never duplicated content, just a pointer back into it.
 * The one place this shape is computed, so the live drive (`withCompaction`,
 * below) and any from-scratch replay that folds the whole event list derive
 * identical `messages` for the same event sequence.
 */
export function deriveCompactedMessages(
  history: readonly Message[],
  compaction: Event["compaction"],
): Message[] {
  const { task, summary, keepLast } = compaction;
  const tail = history.slice(Math.max(0, history.length - keepLast));
  return [...(task ? [task] : []), summary, ...tail];
}

/**
 * Returns a new thread with `messages` replaced per a compaction event —
 * `history` untouched, since only `"message"` events ever extend it (see
 * `deriveCompactedMessages`). Never mutates the thread passed in. Shared by
 * every path that folds a `compact()` effect into the live thread the same
 * way — the main drive loop and a fan-out branch alike.
 */
export function withCompaction(thread: Thread, compaction: Event["compaction"]): Thread {
  return { ...thread, messages: deriveCompactedMessages(thread.history, compaction) };
}

/**
 * Resolves the thread an invalidated node reruns on, per its `threadAction`:
 * `same` keeps the current thread, pushing `reason` onto it if given; `fork`
 * splits onto a new thread that shares the current thread's history so far,
 * linked back by `forkedFrom`; `new` starts a blank thread whose only message
 * is `reason`, if given.
 */
export function applyThreadAction(
  current: Thread,
  threadAction: ThreadAction,
  reason: Message | undefined,
  runtime: Runtime,
): Thread {
  if (threadAction === "new") {
    const messages = reason ? [reason] : [];
    return { id: freshThreadId(runtime), messages, history: [...messages] };
  }

  if (threadAction === "fork") {
    const forked: Thread = {
      id: freshThreadId(runtime),
      forkedFrom: { thread: current.id, at: current.history.length },
      messages: [...current.messages],
      history: [...current.history],
    };
    return reason ? withMessage(forked, reason) : forked;
  }

  // "same": no new thread — return it as-is, or with reason appended.
  return reason ? withMessage(current, reason) : current;
}

/**
 * Owns "last state seen per thread" and emits a `stateChange` event when a
 * node's declared `state` differs from it — omitting `from` on that thread's
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
  private readonly lastState: Map<ThreadId, string>;

  constructor(seed: Iterable<readonly [ThreadId, string]> = []) {
    this.lastState = new Map(seed);
  }

  maybeEmit(
    runtime: Runtime,
    threadId: ThreadId,
    state: string | undefined,
    step?: StepIdentity,
  ): void {
    if (state === undefined) return;
    const previous = this.lastState.get(threadId);
    if (previous === state) return;
    runtime.store.append(
      { ...(previous !== undefined ? { from: previous } : {}), to: state },
      {
        type: "stateChange",
        threadId,
        ...(step
          ? { stepId: step.stepId, ...(step.stepName ? { stepName: step.stepName } : {}) }
          : {}),
      },
    );
    this.lastState.set(threadId, state);
  }
}

/** The `then` edges leaving a node, in declared order — more than one means a fan-out. */
export function thenEdges(edges: readonly EdgeDefinition[], from: NodeId): EdgeDefinition[] {
  return edges.filter((candidate) => candidate.from === from && candidate.edge === "then");
}
