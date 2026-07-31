// Persona coverage validation — the ai half of the coverage split (B2.7).
// Flow-shape coverage (graph structure, waitable providers) stays in
// runtime/coverage.ts's satisfiesFlows; this is the model/binding-aware half.

import type { Graph, NodeKind } from "../graph/graph.js";
import type { PersonaStep } from "../graph/step.js";
import type { Missing } from "../runtime/index.js";
import { walkGraph } from "../runtime/index.js";
import type { Profile } from "./profile.js";
import type { Model } from "./model.js";
import type { Binding, Tool, Toolset } from "./tool.js";
import type { ModelPort } from "./model-port.js";

/** Whether some binding backs a tool or toolset reference, by name. */
function isBound(ref: Tool | Toolset, bindings: Binding[]): boolean {
  return bindings.some(
    (binding) =>
      (binding.kind === "tool" && binding.tool.name === ref.name) ||
      (binding.kind === "toolset" && binding.toolset.name === ref.name),
  );
}

/** Checks each persona directly: does it have a model port, its tools, its reasoning level? */
function satisfiesPersonasArray(
  personas: Profile[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
): Missing[] {
  const missing: Missing[] = [];

  for (const persona of personas) {
    const model = persona.model.identifier;

    if (!models(persona.model)) missing.push({ kind: "model", model });

    for (const ref of persona.tools) {
      if (!isBound(ref, bindings)) missing.push({ kind: "tool", model, tool: ref.name });
    }

    if (persona.reasoning && !persona.model.reasoning.includes(persona.reasoning)) {
      missing.push({ kind: "reasoning", model, level: persona.reasoning });
    }
  }

  return missing;
}

/** Whether a step carries a `.persona` — i.e. is a `PersonaStep`. */
function isPersonaStep(run: unknown): run is PersonaStep {
  return typeof run === "function" && "persona" in run;
}

/** What a walk over a flow's structure collects for persona coverage: every reachable `Profile`. */
interface PersonaCoverage {
  profiles: Profile[];
}

function gatherProfilesFromNode(node: NodeKind, acc: PersonaCoverage, seen: Set<Graph>): void {
  if (node.kind === "step" || node.kind === "interrupt") {
    if (isPersonaStep(node.run)) acc.profiles.push(node.run.persona);
  }
  if (node.kind === "use") {
    walkGraph(node.subgraph, seen, gatherProfilesFromNode, acc);
  }
}

/**
 * Finds every `Profile` a flow could use, by walking its graph's structure statically —
 * no execution involved — then checks each with `satisfiesPersonasArray`: does it have a
 * model port, its declared tools bound, and (if declared) a supported reasoning level?
 * @public
 */
export function satisfiesPersonas(
  flow: Graph,
  config: { models: (model: Model) => ModelPort | undefined; bindings: Binding[] },
): Missing[] {
  const acc: PersonaCoverage = { profiles: [] };
  walkGraph(flow, new Set<Graph>(), gatherProfilesFromNode, acc);
  return satisfiesPersonasArray(acc.profiles, config.models, config.bindings);
}
