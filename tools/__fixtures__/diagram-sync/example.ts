// Fixture for tools/diagram-sync.test.ts — a tiny real Graph to import and
// render, so the sync-check mechanism has something concrete to check
// against without depending on docs/examples/ content that doesn't exist yet.
import { defineGraph } from "../../../packages/core/src/flow/graph.js";

export const example = defineGraph("example", (flow) => {
  const step = flow.step((c) => Promise.resolve(c.output(1)), { label: "step" });
  flow.entry(step);
  step.then(flow.finish);
});
