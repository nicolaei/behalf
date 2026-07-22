// Harness — grid + rank functions. Pure. `grid` builds explore's variants as
// the cross-product of each field's listed values; the rank functions order
// variants by one Metrics field.

import type { Profile, Usage } from "../../../index.js";

/** Builds explore's variants as the cross-product of each field's listed values. @public */
export function grid(axes: {
  [Key in keyof Profile]?: readonly Profile[Key][];
}): Partial<Profile>[] {
  const keys = Object.keys(axes) as (keyof Profile)[];
  return keys.reduce<Partial<Profile>[]>(
    (variants, key) => {
      const values = axes[key] ?? [];
      return variants.flatMap((variant) => values.map((value) => ({ ...variant, [key]: value })));
    },
    [{}],
  );
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
export const byScore: Rank = (metrics) => metrics.score;

/** Faster first. @public */
export const byLatency: Rank = (metrics) => -metrics.latency;

/** Fewer tokens first. @public */
export const byTokens: Rank = (metrics) => -(metrics.usage.input + metrics.usage.output);

/** Free/local first, then cheaper-priced, unknown price last. @public */
export const byCost: Rank = (metrics) => {
  const cost = metrics.usage.cost;
  if (cost === undefined) return -Infinity;
  if (cost === 0) return Infinity;
  return -cost;
};
