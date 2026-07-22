// Graph tests — public barrel. What a test author writing a deterministic
// wiring test imports. Never re-exported from src/index.ts or src/testing/
// index.ts — opt in explicitly, same precedent as src/testing/index.ts
// itself.

export type { Run, ToolTrace, Traversal, NodeVisit } from "./run.js";
export { foldRun, stepOnce, stepUntilBlocked, stepUntil } from "./run.js";

export type { Traverse } from "./traversal.js";
export { sequence, group, loop, branch, matchesTraversal, containsTraversal } from "./traversal.js";

export { nodeCalled } from "./node.js";

// Reused unchanged from the existing low-level module — the condition
// builder for stepUntil.
export { atNode } from "../index.js";
export type { StepResult, StepState } from "../index.js";
