// Systems running flows — satisfiesPersonas / satisfiesFlows. See docs/reference.md.

import type { Profile } from "../flow/profile.js";
import type { Model, ReasoningLevel } from "../flow/model.js";
import type { Graph, NodeKind } from "../flow/graph.js";
import type { Binding, Tool, Toolset } from "../flow/tool.js";
import type { ModelPort } from "./model-port.js";
import type { PersonaStep } from "../flow/step.js";
import type { WaitableSource } from "./waitable-source.js";

/** Everything a persona needs that is not provided. Empty means ready. @public */
export type Missing =
  | { kind: "model"; model: string }
  | { kind: "tool"; model: string; tool: string }
  | { kind: "reasoning"; model: string; level: ReasoningLevel }
  | { kind: "waitable"; provider: string };

/**
 * Thrown by an app's own boot check when `satisfiesFlows`/`satisfiesPersonas` reports anything
 * missing — not thrown by those functions themselves, which stay pure reporters. Carries the
 * full `Missing[]` list so a caller can inspect exactly what's absent, not just that something is.
 * @public
 */
export class FlowNotReadyError extends Error {
  readonly missing: Missing[];

  constructor(missing: Missing[]) {
    super(`flow not ready: ${JSON.stringify(missing)}`);
    this.name = "FlowNotReadyError";
    this.missing = missing;
  }
}

/** Whether some binding backs a tool or toolset reference, by name. */
function isBound(ref: Tool | Toolset, bindings: Binding[]): boolean {
  return bindings.some(
    (binding) =>
      (binding.kind === "tool" && binding.tool.name === ref.name) ||
      (binding.kind === "toolset" && binding.toolset.name === ref.name),
  );
}

/** Checks each persona directly: does it have a model port, its tools, its reasoning level? @public */
export function satisfiesPersonas(
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

/** Collects every `Profile` reachable from a graph's nodes, recursing into `use` subgraphs. */
function personasIn(graph: Graph, profiles: Profile[], seen: Set<Graph>): void {
  if (seen.has(graph)) return;
  seen.add(graph);

  for (const node of graph.nodes.values()) {
    gatherPersonasFromNode(node, profiles, seen);
  }
}

function gatherPersonasFromNode(node: NodeKind, profiles: Profile[], seen: Set<Graph>): void {
  if (node.kind === "step" || node.kind === "interrupt") {
    if (isPersonaStep(node.run)) profiles.push(node.run.persona);
  } else if (node.kind === "use") {
    personasIn(node.subgraph, profiles, seen);
  }
}

/**
 * Finds every `Profile` a set of flows could use, by walking their graphs’
 * structure statically — no execution involved. Each node of kind “step” or
 * “interrupt” carries a `run: Step`; if that step is a `PersonaStep` (it has
 * a `.persona`), its profile is collected. Each node of kind “use” embeds a
 * whole subgraph, so its nodes are walked too, recursively. `waitFor` and
 * “finish” nodes carry no step. The collected profiles are then checked with
 * `satisfiesPersonas`, which already knows what “missing” means for a
 * persona — this function only needs to find every persona in play, not
 * evaluate one.
 * @public
 */
export function satisfiesFlows(
  flows: Graph[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
  // Resolver for a Waitable's provider, mirroring `models`'s shape. Not yet
  // consulted below — collecting a flow's Waitable providers and diffing
  // them against this resolver is the new behavior this signature is
  // pinned down ahead of.
  waitableSources: (provider: string) => WaitableSource | undefined = () => undefined,
): Missing[] {
  // TODO(Story 6 implementer): walk each flow collecting every waitFor/interrupt
  // node's Waitable.provider (recursing into use subgraphs, same shape as
  // personasIn below), then report { kind: "waitable", provider } for any
  // provider !== "userInput" that waitableSources(provider) doesn't resolve.
  void waitableSources;
  const profiles: Profile[] = [];
  const seen = new Set<Graph>();

  for (const flow of flows) {
    personasIn(flow, profiles, seen);
  }

  return satisfiesPersonas(profiles, models, bindings);
}
