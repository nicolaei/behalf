// Test-author-facing vocabulary wrapping tick()/tickUntilSuspended() — the
// fake-timer-library idea (advanceTimersByTime/runAllTimers) applied to this
// engine: purpose-built verbs instead of raw engine internals (`Cursor`,
// `parent`, `FanOutGroup`). `@behalf-js/engine/internal` is exactly that raw
// surface (undocumented, not part of core's main entry) — this package
// wraps it once so a test author never imports `/internal` directly.

import type { Graph, Handle, NodeId, Runtime } from "@behalf-js/engine";
import { seed, driveFlow } from "@behalf-js/engine";
import type { CursorState } from "@behalf-js/engine/internal";
import { tick, tickUntilSuspended } from "@behalf-js/engine/internal";
import { StepUntilError } from "./errors.js";

/** One lane's state within a `StepResult` snapshot — this module's own vocabulary for what the engine calls a `CursorState`. */
export interface StepState {
  laneId: string;
  node: NodeId;
  status: "active" | "parked" | "done";
  // "parked" covers two different situations, distinguished only by whether
  // `waitingFor` is present:
  //  - blocked on external input: a `waitFor` node with nothing in the inbox
  //    yet that matches. `waitingFor` lists the message kinds it's armed for.
  //  - structurally parked: a fan-out branch that finished its own chain and
  //    is waiting on its sibling branches to reach the join. `waitingFor` is
  //    absent here — there's nothing to check the inbox for.
  // A test author asking "is this lane blocked on me?" should check for
  // `waitingFor` being present, not just `status === "parked"`.
  // The kinds are plain strings here: which vocabulary they belong to is the
  // waiting extension's business, not this package's (ai's `MessageKind` is
  // itself just `string`).
  waitingFor?: string[]; // only when parked
  result?: unknown; // only when done
}

/** A single `stepOnce`/`stepUntilBlocked`/`stepUntil` call's outcome — one entry per independently-progressing lane. */
export type StepResult = StepState[];

/**
 * Synthesizes a `laneId` from a cursor's position in the outcome array and
 * its `parent` (the fan-out or `use` node it folds into, absent for the root
 * lane). This is stable *within one call's snapshot* — e.g. distinguishing
 * two fan-out branches returned together — but CursorState carries no
 * explicit identity field, so nothing here promises the same lane gets the
 * same `laneId` across two separate `stepOnce`/`stepUntilBlocked` calls (a
 * branch's position in the array can shift as other branches finish). Test
 * authors comparing lanes across calls should key off `node` instead of
 * `laneId`.
 */
function laneId(cursor: CursorState, index: number): string {
  return `${cursor.parent ?? "root"}#${String(index)}`;
}

/** Maps one engine `CursorState` to this module's own `StepState` vocabulary — straight field-for-field, plus a synthesized `laneId`. */
function toStepState(cursor: CursorState, index: number): StepState {
  return {
    laneId: laneId(cursor, index),
    node: cursor.node,
    status: cursor.status,
    ...(cursor.waitingFor ? { waitingFor: cursor.waitingFor } : {}),
    ...(cursor.result !== undefined ? { result: cursor.result } : {}),
  };
}

/** Advances `flow` exactly one node — a thin wrapper over `tick()`, translated into `StepState`'s vocabulary. */
export async function stepOnce(flow: Graph, runtime: Runtime): Promise<StepResult> {
  const outcome = await tick(flow, runtime);
  return outcome.map(toStepState);
}

/** Drives `flow` until every lane is parked or done — a thin wrapper over `tickUntilSuspended()`, translated into `StepState`'s vocabulary. */
export async function stepUntilBlocked(flow: Graph, runtime: Runtime): Promise<StepResult> {
  const outcome = await tickUntilSuspended(flow, runtime);
  return outcome.map(toStepState);
}

/** Builds a `stepUntil` condition satisfied once any lane sits at `step`. */
export function atNode(step: Handle): (state: StepResult) => boolean {
  return (state) => state.some((lane) => lane.node === step.id);
}

/**
 * Steps `flow` one node at a time (via `stepOnce`, not `tick()` directly) until
 * `condition` is satisfied. Throws `StepUntilError("stalled")` the moment every
 * lane is `"parked"` or `"done"` and the condition still isn't met — that state
 * is deterministic, so stepping again can't help. Throws
 * `StepUntilError("budget-exceeded")` if `maxSteps` (default 1000) is spent
 * while lanes are still active.
 */
export async function stepUntil(
  flow: Graph,
  runtime: Runtime,
  condition: (state: StepResult, runtime: Runtime) => boolean,
  options?: { maxSteps?: number },
): Promise<StepResult> {
  const maxSteps = options?.maxSteps ?? 1000;

  for (let step = 0; step < maxSteps; step += 1) {
    const state = await stepOnce(flow, runtime);
    if (condition(state, runtime)) return state;

    if (state.every((lane) => lane.status !== "active")) {
      throw new StepUntilError(
        "stalled",
        `stepUntil: every lane is parked or done after ${String(step + 1)} step(s) ` +
          "without satisfying the condition",
      );
    }
  }

  throw new StepUntilError(
    "budget-exceeded",
    `stepUntil: exceeded maxSteps (${String(maxSteps)}) without satisfying the condition`,
  );
}

/**
 * Drives `flow` to completion and resolves with the root cursor's result — the
 * run-to-completion verb a test suite wants, assembled from the two primitives
 * a production host wires by hand: `seed()` then `driveFlow()`.
 *
 * Seeds only when the session is empty. On a store that already has events the
 * `input` argument is ignored and the existing session simply resumes, so a test
 * can hand-seed (or half-step) a flow first and still finish it with one call.
 * Re-seeding there would append a second entry event and replay would no longer
 * agree with the caller's real input.
 */
export async function runToCompletion(
  flow: Graph,
  input: unknown,
  runtime: Runtime,
): Promise<unknown> {
  if (runtime.store.events().length === 0) seed(flow, input, runtime);
  return driveFlow(flow, runtime);
}

export { StepUntilError } from "./errors.js";
export { sessionStoreConformance } from "./session-store-conformance.js";
