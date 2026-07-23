// The Learn "Profiles and models" page's example: a concrete Model and the
// Profile built on it. basic.test.ts runs this profile through agentTurn
// with a scripted ModelPort matching its model identifier, so the shape is
// checked by actually driving a turn, not just by typechecking.

import type { Model, Profile } from "@behalf-js/core";

// #region model
export const supportModel: Model = {
  identifier: "claude-sonnet-5",
  provider: "anthropic",
  contextWindow: 1_000_000,
  reasoning: ["off", "low", "medium", "high"],
  price: { input: 3, output: 15 },
};
// #endregion model

// #region profile
export const supportAgent: Profile = {
  model: supportModel,
  system: "You triage support tickets and answer what you can without escalating.",
  tools: [],
  reasoning: "medium",
};
// #endregion profile
