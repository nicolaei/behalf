// Adapter — Anthropic ModelPort. See docs/reference.md § "ModelPort" (opus48 sketch).

import type { Model } from "../../flow/model.js";
import type { ModelPort } from "../../engine/model-port.js";

/** One port per Anthropic model, e.g. Claude Opus. Not yet implemented. @public */
export function createAnthropicPort(model: Model): ModelPort {
  void model;
  throw new Error("createAnthropicPort is not implemented yet");
}
