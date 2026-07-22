// Internal helper shared by scenario.ts and explore.ts — Subject/Agent only
// carry a Profile, never a Graph, so runFlow needs something to drive. This
// builds the canonical one-step "agent" graph: call the model, loop back to
// itself while it used tools, finish otherwise. Same shape already proven in
// run-fold.test.ts (Story 2) and the acceptance suite's agent-loop.test.ts.
// Not exported from eval/index.ts — an implementation detail.

import { defineGraph } from "../../../index.js";
import type { Graph, Profile, ModelCallResult } from "../../../index.js";

export function agentGraph(profile: Profile): Graph {
  return defineGraph("eval-agent", (flow) => {
    const respond = flow.step(async (context) => context.output(await context.modelCall(profile)));
    flow.entry(respond);
    respond
      .when((result) => !(result as ModelCallResult).usedTools, flow.finish)
      .otherwise(respond);
  });
}
