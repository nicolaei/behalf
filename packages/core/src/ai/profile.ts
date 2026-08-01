// AI authoring — Profile and PersonaStep. See docs/reference.md § "Profile".

import type { Step } from "@behalf-js/engine";
import type { Model, ReasoningLevel } from "./model.js";
import type { Tool, Toolset } from "./tool.js";

/** A persona: a structured model, a system prompt, the tools it may call, and a reasoning level. @public */
export interface Profile {
  model: Model;
  system: string;
  tools: (Tool | Toolset)[];
  reasoning?: ReasoningLevel; // must be in model.reasoning — checked with coverage
}

/**
 * A step that uses a model — carries its `persona` so the graph sees it with no separate registration.
 *
 * Lives here rather than in `graph/step.ts` because a persona is ai vocabulary:
 * the engine only ever sees a plain `Step`.
 * @public
 */
export type PersonaStep<Result = unknown> = Step<Result> & { persona: Profile };
