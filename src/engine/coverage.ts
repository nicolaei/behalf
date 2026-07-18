// Systems running flows — satisfiesPersonas / satisfiesFlows. See docs/reference.md.

import type { Profile } from "../flow/profile.js";
import type { Model, ReasoningLevel } from "../flow/model.js";
import type { Graph } from "../flow/graph.js";
import type { Binding } from "../flow/tool.js";
import type { ModelPort } from "./model-port.js";

/** Everything a persona needs that is not provided. Empty means ready. */
export type Missing =
  | { kind: "model"; model: string }
  | { kind: "tool"; model: string; tool: string }
  | { kind: "reasoning"; model: string; level: ReasoningLevel };

export declare function satisfiesPersonas(
  personas: Profile[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
): Missing[];

export declare function satisfiesFlows(
  flows: Graph[],
  models: (model: Model) => ModelPort | undefined,
  bindings: Binding[],
): Missing[];
