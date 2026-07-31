// Eval scorers — one primitive: a Run to a number in 0..1, with a default
// per-run bar.

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

/** Shared shaping for { name, minimumScore, minimumPassRate?, score }. Not exported from the barrel. */
export function scorer<World = unknown, Output = unknown>(
  name: string,
  bars: Bars | undefined,
  score: Scorer<World, Output>["score"],
): Scorer<World, Output> {
  return {
    name,
    minimumScore: bars?.minimumScore ?? 1,
    ...(bars?.minimumPassRate !== undefined ? { minimumPassRate: bars.minimumPassRate } : {}),
    score,
  };
}

/** Did a call to `name` appear in run.tools. @public */
export function toolCalled(name: string, bars?: Bars): Scorer {
  return scorer(`toolCalled(${name})`, bars, (run) =>
    run.tools.some((t) => t.name === name) ? 1 : 0,
  );
}

/** Did a call to `name` whose input satisfies `ok` appear in run.tools. @public */
export function toolCalledWith(name: string, ok: (input: unknown) => boolean, bars?: Bars): Scorer {
  return scorer(`toolCalledWith(${name})`, bars, (run) =>
    run.tools.some((t) => t.name === name && ok(t.input)) ? 1 : 0,
  );
}

/** Does `ok(run.world)` hold. @public */
export function worldMatches<World = unknown>(
  ok: (world: World) => boolean,
  bars?: Bars,
): Scorer<World> {
  return scorer("worldMatches", bars, (run) => (ok(run.world) ? 1 : 0));
}

/** Does `ok(run.output)` hold. @public */
export function outputMatches<Output = unknown>(
  ok: (output: Output) => boolean,
  bars?: Bars,
): Scorer<unknown, Output> {
  return scorer("outputMatches", bars, (run) => (ok(run.output) ? 1 : 0));
}

/** Does `run.lastReply(thread)` match `pattern`. @public */
export function saidOn(thread: string | undefined, pattern: string | RegExp, bars?: Bars): Scorer {
  return scorer("saidOn", bars, (run) => {
    const reply = run.lastReply(thread);
    if (!reply) return 0;
    const text = reply.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const matched = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
    return matched ? 1 : 0;
  });
}

/** Escape hatch — a scorer from any `(run) => number`. @public */
export function scoreBy<World = unknown, Output = unknown>(
  name: string,
  fn: Scorer<World, Output>["score"],
  bars?: Bars,
): Scorer<World, Output> {
  return scorer(name, bars, fn);
}
