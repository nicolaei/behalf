// Harness — grid + rank functions. Pure. `grid` builds explore's variants as
// the cross-product of each field's listed values; the rank functions order
// variants by one Metrics field.
//
// Stub only — see the epic's Story 13 architecture note for the concrete
// behaviour each earns.

import type { Profile, Usage } from "../../../index.js";

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Builds explore's variants as the cross-product of each field's listed values. @public */
export function grid(axes: {
  [Key in keyof Profile]?: readonly Profile[Key][];
}): Partial<Profile>[] {
  void axes;
  return notImplemented("grid");
}

/** One variant's outcome — score, usage, and latency. @public */
export interface Metrics {
  score: number;
  usage: Usage;
  latency: number;
}

/** Orders variants — higher sorts first. @public */
export type Rank = (metrics: Metrics) => number;

/** Higher score first. @public */
export const byScore: Rank = (metrics) => {
  void metrics;
  return notImplemented("byScore");
};

/** Faster first. @public */
export const byLatency: Rank = (metrics) => {
  void metrics;
  return notImplemented("byLatency");
};

/** Fewer tokens first. @public */
export const byTokens: Rank = (metrics) => {
  void metrics;
  return notImplemented("byTokens");
};

/** Free/local first, then cheaper-priced, unknown price last. @public */
export const byCost: Rank = (metrics) => {
  void metrics;
  return notImplemented("byCost");
};
