// Graph-test primitives — stepOnce/stepUntilBlocked/stepUntil folding a Run.
// Built directly on the existing low-level src/testing/index.ts primitives
// (same names, same StepResult-driving machinery over `tick()`) — this module
// just folds their result into a Run instead of a StepResult. No `input`
// parameter anywhere here: fake models/tools never read message content, so
// the empty thread `tick` already starts with is correct as-is.
//
// Stub only — see the epic's Story 1/2/3/6 architecture notes for the
// concrete behaviour each earns.

import type {
  Graph,
  NodeId,
  ThreadId,
  Message,
  AssistantMessage,
  Usage,
  Runtime,
} from "../../index.js";
import type { StepResult } from "../index.js";

/** One tool call folded from a run's log — call, result, and where it happened. @public */
export interface ToolTrace {
  name: string;
  input: unknown;
  output: unknown;
  isError?: boolean;
  node: NodeId;
  thread: ThreadId;
}

/** The nodes a run entered, in log order. @public */
export type Traversal = { node: NodeId; name?: string; thread: ThreadId }[];

/** One node's visit — its input, its output, and which thread it ran on. @public */
export interface NodeVisit {
  node: NodeId;
  input: unknown[];
  output: unknown;
  thread: ThreadId;
}

/** The fold every assertion reads — one flow's log, folded into what a test asserts on. @public */
export interface Run<World = unknown, Output = unknown> {
  output: Output;
  world: World;
  tools: ToolTrace[];
  traversal: Traversal;
  visits: NodeVisit[];
  usage: Usage;
  latency: number;
  readonly threads: { id: ThreadId; label?: string }[];
  lastReply(thread?: ThreadId | string): AssistantMessage | undefined;
  messages(thread?: ThreadId | string): Message[];
}

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Folds a runtime's committed log + the fixture's world into a Run. @public */
export function foldRun<World, Output = unknown>(
  events: unknown[],
  world: World,
  latency: number,
): Run<World, Output> {
  void events;
  void world;
  void latency;
  return notImplemented("foldRun");
}

/** Advances `flow` exactly one node, folding the result into a Run. @public */
export async function stepOnce<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
): Promise<Run<World, Output>> {
  void flow;
  void runtime;
  await Promise.resolve();
  return notImplemented("stepOnce");
}

/** Drives `flow` until every lane is parked or done, folding the result into a Run. @public */
export async function stepUntilBlocked<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
): Promise<Run<World, Output>> {
  void flow;
  void runtime;
  await Promise.resolve();
  return notImplemented("stepUntilBlocked");
}

/** Drives `flow` until `condition` holds, folding the result into a Run. @public */
export async function stepUntil<World, Output = unknown>(
  flow: Graph,
  runtime: Runtime,
  condition: (state: StepResult) => boolean,
): Promise<Run<World, Output>> {
  void flow;
  void runtime;
  void condition;
  await Promise.resolve();
  void condition;
  return notImplemented("stepUntil");
}
