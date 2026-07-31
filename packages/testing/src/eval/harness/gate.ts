// Harness — gate(). Pure: canned scores in, pass/fail + pass-rate out. What
// makes scenario's gating logic unit-testable without running anything.

/** Did enough of `scores` clear `minimumScore` to satisfy `minimumPassRate`. @public */
export function gate(opts: { scores: number[]; minimumScore: number; minimumPassRate: number }): {
  passed: boolean;
  passRate: number;
} {
  const { scores, minimumScore, minimumPassRate } = opts;
  const passRate =
    scores.length === 0 ? 0 : scores.filter((s) => s >= minimumScore).length / scores.length;
  return { passed: passRate >= minimumPassRate, passRate };
}
