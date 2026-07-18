// Adapter — Anthropic ModelPort. See docs/reference.md § "ModelPort" (opus48 sketch).

import type { Model } from "../../flow/model.js";
import type { ModelPort } from "../../engine/model-port.js";

/** One port per Anthropic model, e.g. Claude Opus. Not yet implemented. */
export declare function createAnthropicPort(model: Model): ModelPort;
