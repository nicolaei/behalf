// Dev tooling — render a real Graph as Mermaid flowchart syntax, so a diagram
// can be generated from (and kept honest against) the graph it depicts,
// instead of hand-drawn and free to drift. See docs/style-guide.md's
// example-file mechanism for the same idea applied to code snippets.
//
// Lives outside src/ deliberately: this is a repo-internal dev tool for
// generating docs diagrams, not part of the published library's API surface.
// It reaches into src/flow/*.js directly (including types the public barrel
// doesn't export, like NodeKind/EdgeDefinition) rather than importing the
// built "behalf" package, since it's in-repo tooling, not a consumer.

import type { Graph, NodeId, NodeKind, EdgeDefinition } from "../src/flow/graph.js";
import type { PersonaStep, JoinStep } from "../src/flow/step.js";
import type { ThreadAction } from "../src/flow/thread.js";

function escapeLabel(label: string): string {
  return label.replace(/"/g, "&quot;");
}

function isPersonaStep(run: unknown): run is PersonaStep {
  return typeof run === "function" && "persona" in run;
}

function isJoinStep(run: unknown): run is JoinStep {
  return typeof run === "function" && (run as Partial<JoinStep>).join === true;
}

/** One node declaration line — the shape encodes the node kind, the label its identity. */
function renderNode(id: NodeId, node: NodeKind): string {
  switch (node.kind) {
    case "step": {
      const label = escapeLabel(node.label ?? id);
      if (isJoinStep(node.run)) return `${id}{{"${label}"}}`; // hexagon — a fan-out convergence point
      if (isPersonaStep(node.run)) return `${id}("${label}")`; // rounded — a persona calls a model
      return `${id}["${label}"]`; // rectangle — a plain step
    }
    case "use":
      return `${id}[["use: ${escapeLabel(node.subgraph.name)}"]]`; // subroutine — composes another graph
    case "waitFor":
      return `${id}(["waitFor: ${escapeLabel(node.waitable.label)}"])`; // stadium — parks until resolved
    case "interrupt":
      return `${id}>"interrupt: ${escapeLabel(node.waitable.label)}"]`; // asymmetric — always armed
    case "forEach":
      return `${id}[/"forEach"/]`; // parallelogram — dynamic, runtime-sized fan-out
    case "finish":
      return `${id}(("finish"))`; // circle — the terminal node
  }
}

/** One edge's label: a custom `label` wins outright; otherwise `when`/`otherwise` fall back to their
 *  kind name and a plain `then` stays unlabeled — either way, a non-default `threadAction` is appended. */
function renderEdgeLabel(edge: EdgeDefinition): string | undefined {
  const base = edge.options?.label ?? (edge.edge === "then" ? undefined : edge.edge);
  const threadAction: ThreadAction | undefined = edge.options?.threadAction;
  const suffix = threadAction && threadAction !== "same" ? ` (${threadAction})` : "";
  if (base === undefined) return suffix ? `then${suffix}` : undefined;
  return `${base}${suffix}`;
}

function renderEdge(edge: EdgeDefinition): string {
  const label = renderEdgeLabel(edge);
  return label
    ? `${edge.from} -->|"${escapeLabel(label)}"| ${edge.to}`
    : `${edge.from} --> ${edge.to}`;
}

/** Renders `graph` as a Mermaid `flowchart` diagram — generated from the real wiring, not hand-drawn. */
export function graphToMermaid(graph: Graph): string {
  const lines = ["flowchart TB"];
  for (const [id, node] of graph.nodes) lines.push(`  ${renderNode(id, node)}`);
  for (const edge of graph.edges) lines.push(`  ${renderEdge(edge)}`);
  return lines.join("\n");
}
