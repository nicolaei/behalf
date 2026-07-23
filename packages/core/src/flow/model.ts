// Flow authoring — Model. See docs/reference.md § "Model".

/** Supported reasoning intensity levels for models that expose extended thinking. @public */
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A model descriptor: provider, context window, supported reasoning levels, and optional pricing. @public */
export interface Model {
  identifier: string;
  provider: string;
  contextWindow: number;
  reasoning: ReasoningLevel[]; // supported levels; [] = none
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
