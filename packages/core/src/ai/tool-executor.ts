// The ai extension's tool half: resolving a named tool's handler, building the
// ToolContext handlers run with, running one tool call end to end, and the
// decoupled background tool executor that watches the log for pending calls.
// Physically relocated out of runtime/execution.ts (B2.7) — the model-call
// half lives alongside this in model-call.ts.

import type { NodeId } from "../graph/graph.js";
import type { ScopeId } from "../graph/thread.js";
import type { Runtime, StepIdentity } from "../runtime/index.js";
import { stepIdentity, freshCorrelationId } from "../runtime/index.js";
import type { AgentSpawner } from "./agent-spawner.js";
import type { Tool, ToolContext, ToolHandler, Binding } from "./tool.js";
import type { Model } from "./model.js";
import type { ModelPort } from "./model-port.js";

/** Resolves every `kind === "toolset"` binding's members (via its `discover()`, called exactly once) merged with every `kind === "tool"` binding — a single name-keyed lookup `findToolBinding` reads from. */
async function expandToolsets(bindings: Binding[]): Promise<Map<string, ToolHandler>> {
  const resolved = new Map<string, ToolHandler>();
  for (const binding of bindings) {
    if (binding.kind === "tool") {
      resolved.set(binding.tool.name, binding.handler);
      continue;
    }
    const members = await binding.discover();
    for (const [name, handler] of Object.entries(members)) {
      resolved.set(name, handler);
    }
  }
  return resolved;
}

/** Every tool binding resolved for a given Runtime — keyed off the returned Runtime in a module-scoped `WeakMap` rather than the public type, so this stays an implementation detail. Populated by `ai()`'s own `workers` hook. */
export const resolvedTools = new WeakMap<Runtime, Map<string, ToolHandler>>();

/** The model resolver `ai({ models })` was given for a given Runtime — same WeakMap-keyed-by-Runtime shape as `resolvedTools`, populated alongside it. */
export const modelResolvers = new WeakMap<Runtime, (model: Model) => ModelPort>();

/** The `AgentSpawner` `ai({ spawner })` was given for a given Runtime, if any — same WeakMap-keyed-by-Runtime shape as `resolvedTools`. Absent when the host registered none, which is what makes `context.spawnAgent` fail loudly rather than silently doing something else. */
export const agentSpawners = new WeakMap<Runtime, AgentSpawner>();

/** Finds the resolved handler for a named tool — direct or a toolset member — or throws if the runtime has none. */
export function findToolBinding(runtime: Runtime, name: string): ToolHandler {
  const handler = resolvedTools.get(runtime)?.get(name);
  if (!handler) throw new Error(`no tool binding for "${name}"`);
  return handler;
}

/** The `ToolContext` every tool handler runs with, wherever it's called from. */
export function buildToolContext(
  scope: ScopeId,
  runtime: Runtime,
  identity: StepIdentity,
  correlationId: string,
): ToolContext {
  return {
    thread: scope,
    correlationId,
    openStream: (type) =>
      runtime.store.open({
        correlationId: freshCorrelationId(runtime),
        type,
        threadId: scope,
        ...identity,
      }),
    appendEvent: (payload, type) => {
      runtime.store.append(payload, { type, threadId: scope });
    },
    spawnAgent: (flow, brief) => {
      const spawner = agentSpawners.get(runtime);
      if (!spawner) {
        throw new Error(
          "context.spawnAgent requires an AgentSpawner — pass one as ai({ ..., spawner })",
        );
      }
      // Keyed by THIS tool call's own correlationId: that is what makes a
      // re-dispatch of the same pending call attach to the existing child.
      return spawner.spawn(correlationId, flow, brief);
    },
  };
}

/**
 * Executes one already-committed tool call end to end: resolves its binding, runs the handler,
 * and commits its `toolResult` — always, even when the handler's own promise rejects. A handler
 * rejection is caught here and folded into the committed event as `{ output: { error: message },
 * isError: true }` rather than left to propagate: the only thing that ever resolves a pending
 * `waitFor(toolCall(id))` is a matching `toolResult` event, so a handler that throws without one
 * would park that Waitable forever. `findToolBinding` failing (no binding registered for this
 * name, in THIS runtime) is deliberately left uncaught, not folded into an isError result: a
 * missing binding models a call meant to be resolved by some other process sharing the same log,
 * or a standalone `appendEvent`'d toolCall never meant to dispatch at all — both rely on staying
 * genuinely pending. This is the decoupled tool executor's sole dispatch path.
 */
export async function executeToolCall(
  call: { correlationId: string; name: string; input: unknown },
  scope: ScopeId,
  runtime: Runtime,
  identity: StepIdentity,
): Promise<unknown> {
  const handler = findToolBinding(runtime, call.name);
  const toolContext = buildToolContext(scope, runtime, identity, call.correlationId);

  let output: unknown;
  let isError = false;
  try {
    output = await handler(call.input, toolContext);
  } catch (error) {
    isError = true;
    output = { error: error instanceof Error ? error.message : String(error) };
  }

  runtime.store.append(
    { correlationId: call.correlationId, output, ...(isError ? { isError: true } : {}) },
    { type: "toolResult", threadId: scope },
  );

  return output;
}

/** A fixed identity every dispatch from the decoupled tool executor logs under — it runs
 * independently of any node, so there's no real step id to attribute a dispatch to. */
const TOOL_EXECUTOR_IDENTITY: StepIdentity = stepIdentity(
  "tool-executor" as NodeId,
  "tool-executor",
);

/**
 * The decoupled tool executor's watch loop: scans the committed log for `toolCall` events with no
 * matching `toolResult` yet, and dispatches each independently of whatever step requested it.
 * Wakes via `store.awaitReceive()`, then re-scans the committed log rather than trusting anything
 * buffered from a previous wake. Runs until `signal` aborts (see `ai()`'s `workers` hook and
 * `Runtime.stop()`). Idempotency: a correlationId is marked dispatched the instant it's found
 * pending, before its handler even starts, so a later wake never dispatches the same call twice.
 */
export async function runToolExecutorLoop(runtime: Runtime, signal: AbortSignal): Promise<void> {
  const store = runtime.store;
  const dispatched = new Set<string>();

  function pendingToolCalls(): {
    correlationId: string;
    name: string;
    input: unknown;
    threadId: ScopeId;
  }[] {
    const events = store.events();
    const resolved = new Set<string>();
    for (const envelope of events) {
      if (envelope.form === "committed" && envelope.type === "toolResult") {
        resolved.add((envelope.event as { correlationId: string }).correlationId);
      }
    }

    const pending: {
      correlationId: string;
      name: string;
      input: unknown;
      threadId: ScopeId;
    }[] = [];
    for (const envelope of events) {
      if (envelope.form !== "committed" || envelope.type !== "toolCall") continue;
      if (!envelope.threadId) continue; // a toolCall is always committed with its owning scope
      const event = envelope.event as { correlationId: string; name: string; input: unknown };
      if (resolved.has(event.correlationId) || dispatched.has(event.correlationId)) continue;
      pending.push({ ...event, threadId: envelope.threadId });
    }
    return pending;
  }

  while (!signal.aborted) {
    for (const call of pendingToolCalls()) {
      dispatched.add(call.correlationId);
      executeToolCall(call, call.threadId, runtime, TOOL_EXECUTOR_IDENTITY).catch(() => {
        // executeToolCall itself catches a rejecting handler and commits an isError
        // toolResult, so a normal handler failure never reaches here. This only guards
        // a truly unexpected failure (e.g. store.append itself throwing) — swallowed
        // rather than crashing the whole watcher.
      });
    }
    await store.awaitReceive();
  }
}

/**
 * Calls a tool directly, with no model in the loop: resolves its binding and
 * returns the handler's result as-is — no logging or thread-folding, unlike
 * `executeToolCall`, since nothing here asks a model to see the result.
 */
export async function callTool<Input, Output>(
  tool: Tool<Input, Output>,
  input: Input,
  scope: ScopeId,
  runtime: Runtime,
  identity: StepIdentity,
): Promise<Output> {
  const handler = findToolBinding(runtime, tool.name);
  const toolContext = buildToolContext(scope, runtime, identity, freshCorrelationId(runtime));
  return handler(input, toolContext) as Promise<Output>;
}

/**
 * Builds the `EngineExtension.workers` entry `ai()` registers. Records the model resolver
 * synchronously, and starts the tool-executor loop synchronously too — both happen before
 * `runtime()` itself returns, matching the timing the old hardcoded `startToolExecutor(ready)`
 * call gave every caller. Toolset expansion (`expandToolsets`, genuinely async only when a
 * binding is a toolset needing `discover()`) resolves in parallel rather than blocking the
 * loop's own first log scan: a `toolCall` dispatched before it settles simply isn't found in
 * `resolvedTools` yet — the same "not yet resolved" state `findToolBinding` already tolerates
 * for any binding a caller hasn't registered. Awaiting it first (inside the returned worker
 * function, before calling `runToolExecutorLoop`) would delay that loop's own first
 * `store.awaitReceive()` subscription by a real microtask tick relative to before — a gap a
 * timing-sensitive replay race (see multi-turn-replay-after-restart.test.ts) can actually fall
 * into, so this stays synchronous on purpose, not merely for tidiness.
 */
export function createAiWorkers(config: {
  models: (model: Model) => ModelPort;
  bindings: Binding[];
  spawner?: AgentSpawner;
}): (runtime: Runtime, signal: AbortSignal) => (() => Promise<void>)[] {
  return (runtime, signal) => {
    modelResolvers.set(runtime, config.models);
    if (config.spawner) agentSpawners.set(runtime, config.spawner);
    void expandToolsets(config.bindings).then((tools) => {
      resolvedTools.set(runtime, tools);
    });
    return [() => runToolExecutorLoop(runtime, signal)];
  };
}
