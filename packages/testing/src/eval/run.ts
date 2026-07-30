// Eval core data shape — Run/foldRun. New to `packages/testing`: today's
// engine has no Run type and no foldRun — packages/testing's `stepOnce`/
// `stepUntilBlocked`/`stepUntil` return a different shape entirely (lane
// status snapshots, not a folded execution). Built fresh here, using the
// unmerged `testing-framework` branch's `src/testing/graph/run.ts` as a
// design reference only.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Envelope, AssistantMessage, Message, ThreadId, NodeId, Usage } from "@behalf-js/core";

/** One tool call+result pair, matched by correlationId. `output`/`isError` are absent if the call never resolved. @public */
export interface ToolTrace {
  correlationId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

/** Nodes entered, in log order. @public */
export type Traversal = NodeId[];

/** One node's visit — its thread, and what flowed through it. @public */
export interface NodeVisit {
  node: NodeId;
  thread: ThreadId;
  input: unknown;
  output: unknown;
}

/**
 * Every scorer reads a `Run`, folded from one flow execution's committed
 * event log. Produced by driving a synthesized one-step "agent" graph
 * (`agentGraph(profile)`) through `runFlow` — evals always run a case to
 * completion, they don't pause mid-flow.
 * @public
 */
export interface Run<World = unknown, Output = unknown> {
  output: Output;
  world: World;
  tools: ToolTrace[];
  traversal: Traversal;
  visits: NodeVisit[];
  usage: Usage;
  latency: number;
  threads: { id: ThreadId; label?: string }[];
  lastReply(thread?: string): AssistantMessage | undefined;
  messages(thread?: string): Message[];
}

/** Folds one flow execution's committed event log into a `Run`. Built out in a later phase — Phase 0 only stubs the signature. */
export function foldRun<World = unknown, Output = unknown>(
  _events: Envelope[],
  _world: World,
  _latency: number,
): Run<World, Output> {
  throw new Error("not implemented");
}
