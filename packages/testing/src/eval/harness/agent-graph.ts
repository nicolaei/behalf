// Internal helper shared by scenario.ts and explore.ts — Subject/Agent only
// carry a Profile, never a Graph, so runFlow needs something to drive. This
// builds the canonical one-step "agent" graph: call the model, loop back to
// itself while it used tools, finish otherwise.
//
// Not exported from eval/index.ts — an implementation detail.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { Graph, Profile } from "@behalf-js/core";

export function agentGraph(_profile: Profile): Graph {
  throw new Error("not implemented");
}
