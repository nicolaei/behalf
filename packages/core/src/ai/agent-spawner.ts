// The AgentSpawner port behind ai's `spawnAgent` — how a tool handler starts a
// child agent. A spawned agent is a child *session* with its own log, not a
// sub-flow sharing the parent's: `tick()` reconstructs a session's position
// from the whole store, so two independently-driven agents on one log would
// read each other's events as their own.

import type { Graph } from "../graph/graph.js";
import type { SessionId } from "../session/envelope.js";
import type { Runtime } from "../runtime/index.js";
import { seed, driveFlow } from "../runtime/index.js";
import type { Message } from "./message.js";

/** What a finished child delivers — the shape a `finish_task`-style tool sends. @public */
export interface FinishResult {
  result: string;
  reason?: string;
  succeeded: boolean;
}

/** Returned by `spawnAgent`. `result()` is durable: it resolves from the child's own log, so it stays awaitable after a restart. @public */
export interface AgentHandle {
  readonly id: SessionId;
  result(): Promise<FinishResult>;
}

/**
 * The port a host implements: create, or re-attach to, a child session.
 *
 * `key` is the spawning tool call's own `correlationId`, which makes `spawn`
 * idempotent — the decoupled tool executor re-dispatching a still-pending call
 * after a restart must attach to the child already running rather than start a
 * second one.
 * @public
 */
export interface AgentSpawner {
  spawn(key: string, flow: Graph, brief: Message): AgentHandle;
}

/** How `localAgentSpawner` gets a child session's own `Runtime`. @public */
export interface LocalAgentSpawnerConfig {
  /**
   * Builds (or rebuilds) the child session's Runtime for `key`. The host owns
   * where that session's store lives and how it is keyed — returning a Runtime
   * over an ALREADY-POPULATED store is exactly how re-attachment works, since
   * driving resumes from the log rather than restarting the flow.
   */
  createRuntime: (key: string) => Promise<Runtime>;
}

/**
 * Folds a child flow's terminal value into a `FinishResult`. A flow whose own
 * finish already produces that shape (an `agentTurn` ending on a
 * `finish_task`-style tool) passes through untouched; anything else is reported
 * as a successful run whose `result` is the terminal value rendered as text —
 * the honest reading of "the flow reached `finish` and this is what it
 * carried".
 */
function asFinishResult(output: unknown): FinishResult {
  if (typeof output === "object" && output !== null && "result" in output && "succeeded" in output) {
    return output as FinishResult;
  }
  return { result: typeof output === "string" ? output : JSON.stringify(output), succeeded: true };
}

/**
 * The in-process `AgentSpawner`: each child runs on its own Runtime and store,
 * driven by the same `seed()` + `driveFlow()` pair a host uses for any session.
 *
 * Idempotency has two layers, and both matter. Within one process, a `key`
 * already spawned returns the same `AgentHandle` — the child is driven once,
 * however many times the tool call is dispatched. Across a restart, the
 * in-memory map is gone, so idempotency falls to the store: `createRuntime`
 * hands back a Runtime over the child's surviving log, and driving it seeds
 * only when that log is empty. A finished child therefore replays straight to
 * its own result without re-running a single step, and an unfinished one
 * resumes where it stopped.
 * @public
 */
export function localAgentSpawner(config: LocalAgentSpawnerConfig): AgentSpawner {
  const live = new Map<string, AgentHandle>();

  return {
    spawn(key, flow, brief) {
      const existing = live.get(key);
      if (existing) return existing;

      // Started once, on first `result()`, and shared by every later caller —
      // so two awaits of the same handle drive the child once, not twice.
      let running: Promise<FinishResult> | undefined;
      const handle: AgentHandle = {
        id: key as SessionId,
        result() {
          running ??= (async () => {
            const childRuntime = await config.createRuntime(key);
            // Seed only into an empty log. On a re-attach the brief was already
            // recorded by the original spawn, and appending a second `input`
            // event would give replay two starting facts to disagree over.
            if (childRuntime.store.events().length === 0) seed(flow, brief, childRuntime);
            const output = await driveFlow(flow, childRuntime);
            return asFinishResult(output);
          })();
          return running;
        },
      };
      live.set(key, handle);
      return handle;
    },
  };
}
