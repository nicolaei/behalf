// Eval-style tests — public barrel. What a test author writing a quality
// eval imports. Never re-exported from the package's top-level src/index.ts
// — opt in explicitly via the "@behalf-js/testing/eval" subpath export.

export type { Subject, Agent } from "./subject.js";
export { agent } from "./subject.js";

export type { Fixtures, Example } from "./fixtures.js";
export { example } from "./fixtures.js";

export type { Bars, Scorer } from "./scorers.js";
export { toolCalled, toolCalledWith, worldMatches, outputMatches, saidOn, scoreBy } from "./scorers.js";

export type { Judge } from "./judge.js";
export { llmJudge } from "./judge.js";

export type { Distribution, RegressionPolicy, BaselineStore } from "./regression.js";
export { variance, fixed, checkRegression, jsonlBaselineStore } from "./regression.js";

export { gate } from "./harness/gate.js";
export { aggregate } from "./harness/aggregate.js";

export type { Metrics, Rank } from "./harness/rank.js";
export { grid, byScore, byTimeToComplete, byTokens, byCost } from "./harness/rank.js";

export { scenario } from "./harness/scenario.js";
export { explore } from "./harness/explore.js";
