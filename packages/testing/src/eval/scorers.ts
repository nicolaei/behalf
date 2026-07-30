// Eval scorers — one primitive: a Run to a number in 0..1, with a default
// per-run bar.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Run } from "./run.js";

/** Per-scorer bar overrides. @public */
export interface Bars {
  minimumScore?: number;
  minimumPassRate?: number;
}

/** One scorer: a Run to a number in 0..1, with its own per-run bar. @public */
export interface Scorer<World = unknown, Output = unknown> {
  name: string;
  minimumScore: number;
  minimumPassRate?: number;
  score: (run: Run<World, Output>) => number | Promise<number>;
}

/** Did a call to `name` appear in run.tools. @public */
export function toolCalled(_name: string, _bars?: Bars): Scorer {
  throw new Error("not implemented");
}

/** Did a call to `name` whose input satisfies `ok` appear in run.tools. @public */
export function toolCalledWith(
  _name: string,
  _ok: (input: unknown) => boolean,
  _bars?: Bars,
): Scorer {
  throw new Error("not implemented");
}

/** Does `ok(run.world)` hold. @public */
export function worldMatches<World = unknown>(
  _ok: (world: World) => boolean,
  _bars?: Bars,
): Scorer<World> {
  throw new Error("not implemented");
}

/** Does `ok(run.output)` hold. @public */
export function outputMatches<Output = unknown>(
  _ok: (output: Output) => boolean,
  _bars?: Bars,
): Scorer<unknown, Output> {
  throw new Error("not implemented");
}

/** Does `run.lastReply(thread)` match `pattern`. @public */
export function saidOn(_thread: string | undefined, _pattern: string | RegExp, _bars?: Bars): Scorer {
  throw new Error("not implemented");
}

/** Escape hatch — a scorer from any `(run) => number`. @public */
export function scoreBy<World = unknown, Output = unknown>(
  _name: string,
  _fn: Scorer<World, Output>["score"],
  _bars?: Bars,
): Scorer<World, Output> {
  throw new Error("not implemented");
}
