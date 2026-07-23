// Routing — edge selection, thread-action application, and the shared
// output/route-commit helpers every node kind's own routing goes through.

import type { Message } from "../../flow/message.js";
import type { NodeId, EdgeDefinition } from "../../flow/graph.js";
import type { ThreadAction, ThreadId } from "../../flow/thread.js";
import type { StepContext } from "../../flow/step.js";
import type { Runtime } from "../runtime.js";
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

/** The `then` edges leaving a node, in declared order — more than one means a fan-out. */
export function thenEdges(edges: readonly EdgeDefinition[], from: NodeId): EdgeDefinition[] {
  return edges.filter((candidate) => candidate.from === from && candidate.edge === "then");
}
