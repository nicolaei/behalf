// Harness — aggregate(). Pure: a raw score array folded into a Distribution.
//
// Stub only — see the epic's Story 12 architecture note for the concrete
// behaviour this earns.

import type { Distribution } from "../regression.js";

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** Folds a raw score array into mean/median/stddev/min/max/passRate. @public */
export function aggregate(scores: number[]): Distribution {
  void scores;
  return notImplemented("aggregate");
}
