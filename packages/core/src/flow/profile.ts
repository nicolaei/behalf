// Flow authoring — Profile. See docs/reference.md § "Profile".

import type { Model, ReasoningLevel } from "./model.js";
import type { Tool, Toolset } from "./tool.js";

/** A persona: a structured model, a system prompt, the tools it may call, and a reasoning level. @public */
export interface Profile {
  model: Model;
  system: string;
  tools: (Tool | Toolset)[];
  reasoning?: ReasoningLevel; // must be in model.reasoning — checked with coverage
}
