// Flow authoring — Model. See docs/reference.md § "Model".

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Model {
  identifier: string;
  provider: string;
  contextWindow: number;
  reasoning: ReasoningLevel[]; // supported levels; [] = none
  price?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}
