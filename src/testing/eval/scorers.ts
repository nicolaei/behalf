// Eval scorers — one primitive: a Run to a number in 0..1, with a default
// per-run bar. Pure — hand-built Run literals, no engine.
//
// Stub only — see the epic's Story 9 architecture note for the concrete
// behaviour each earns.

import type { Run } from "../graph/run.js";

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

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Did a call to `name` appear in run.tools. @public */
export function toolCalled(name: string, bars?: Bars): Scorer {
  void name;
  void bars;
  return notImplemented("toolCalled");
}

/** Did a call to `name` whose input satisfies `ok` appear in run.tools. @public */
export function toolCalledWith(name: string, ok: (input: unknown) => boolean, bars?: Bars): Scorer {
  void name;
  void ok;
  void bars;
  return notImplemented("toolCalledWith");
}

/** Does `ok(run.world)` hold. @public */
export function worldMatches<World>(ok: (world: World) => boolean, bars?: Bars): Scorer<World> {
  void ok;
  void bars;
  return notImplemented("worldMatches");
}

/** Does `ok(run.output)` hold. @public */
export function outputMatches<Output>(
  ok: (output: Output) => boolean,
  bars?: Bars,
): Scorer<unknown, Output> {
  void ok;
  void bars;
  return notImplemented("outputMatches");
}

/** Does `run.lastReply(thread)` match `pattern`. @public */
export function saidOn(thread: string | undefined, pattern: string | RegExp, bars?: Bars): Scorer {
  void thread;
  void pattern;
  void bars;
  return notImplemented("saidOn");
}

/** Escape hatch — a scorer from any `(run) => number`. @public */
export function scoreBy<World, Output>(
  name: string,
  fn: Scorer<World, Output>["score"],
  bars?: Bars,
): Scorer<World, Output> {
  void name;
  void fn;
  void bars;
  return notImplemented("scoreBy");
}
