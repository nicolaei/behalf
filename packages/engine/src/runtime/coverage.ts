// Systems running flows — satisfiesFlows: flow-shape coverage (graph
// structure, registered Waitable providers), no model/binding awareness.
// Persona coverage moved to ai/coverage.ts's satisfiesPersonas (B2.7).

import type { Graph, NodeKind } from "../graph/graph.js";
import type { WaitableSource } from "./waitable-source.js";

/** Everything a persona or flow needs that is not provided. Empty means ready. @public */
export type Missing =
  | { kind: "model"; model: string }
  | { kind: "tool"; model: string; tool: string }
  | { kind: "reasoning"; model: string; level: string }
  | { kind: "waitable"; provider: string };

/**
 * Thrown by an app's own boot check when `satisfiesFlows`/ai's `satisfiesPersonas` reports
 * anything missing — not thrown by those functions themselves, which stay pure reporters.
 * Carries the full `Missing[]` list so a caller can inspect exactly what's absent, not just
 * that something is.
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

/**
 * Generic recursive graph walker: visits every node reachable from `graph` — including through
 * `use` subgraphs — calling `gatherFromNode` on each, and skipping any graph already in `seen`.
 * Shared by every static-collection pass over a flow's structure (this file's own
 * `satisfiesFlows`, and ai/coverage.ts's `satisfiesPersonas`) so a subgraph reachable from more
 * than one place is only ever walked once per `seen` set. @public
 */
export function walkGraph<T>(
  graph: Graph,
  seen: Set<Graph>,
  gatherFromNode: (node: NodeKind, acc: T, seen: Set<Graph>) => void,
  acc: T,
): void {
  if (seen.has(graph)) return;
  seen.add(graph);

  for (const node of graph.nodes.values()) {
    gatherFromNode(node, acc, seen);
  }
}

/** What `satisfiesFlows` collects from a single walk over a flow's structure: every distinct Waitable provider. */
interface FlowCoverage {
  providers: Set<string>;
}

/** Gathers one node's own contribution to a `FlowCoverage`, recursing into a `use` node's subgraph via `walkGraph`. */
function gatherProvidersFromNode(node: NodeKind, acc: FlowCoverage, seen: Set<Graph>): void {
  if (node.kind === "waitFor" || node.kind === "interrupt") {
    acc.providers.add(node.waitable.provider);
  }
  if (node.kind === "use") {
    walkGraph(node.subgraph, seen, gatherProvidersFromNode, acc);
  }
}

/**
 * Finds every `Waitable` provider a set of flows could use, by walking their graphs' structure
 * statically — no execution involved. `"userInput"` is always satisfied (no source is ever
 * required for it — it's resolved by whatever surfaces messages to a human, not a registered
 * `WaitableSource`); every other provider must resolve via `waitableSources(provider)` or it's
 * reported missing. Graph-shape coverage only — no model/binding awareness; see ai/coverage.ts's
 * `satisfiesPersonas` for that half.
 * @public
 */
export function satisfiesFlows(
  flows: Graph[],
  waitableSources: (provider: string) => WaitableSource | undefined = () => undefined,
): Missing[] {
  const acc: FlowCoverage = { providers: new Set<string>() };
  const seen = new Set<Graph>();

  for (const flow of flows) {
    walkGraph(flow, seen, gatherProvidersFromNode, acc);
  }

  const missing: Missing[] = [];
  for (const provider of acc.providers) {
    if (provider === "userInput") continue;
    if (!waitableSources(provider)) missing.push({ kind: "waitable", provider });
  }

  return missing;
}
