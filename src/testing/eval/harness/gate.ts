// Harness — gate(). Pure: canned scores in, pass/fail + pass-rate out. What
// makes scenario's gating logic unit-testable without running anything.
//
// Stub only — see the epic's Story 12 architecture note for the concrete
// behaviour this earns.

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Did enough of `scores` clear `minimumScore` to satisfy `minimumPassRate`. @public */
export function gate(opts: { scores: number[]; minimumScore: number; minimumPassRate: number }): {
  passed: boolean;
  passRate: number;
} {
  void opts;
  return notImplemented("gate");
}
