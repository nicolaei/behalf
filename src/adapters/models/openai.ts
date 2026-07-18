// Adapter — OpenAI ModelPort. See docs/reference.md § "ModelPort" (gpt55 sketch).

import type { Model } from "../../flow/model.js";
import type { ModelPort } from "../../engine/model-port.js";

/** One port per OpenAI model, via the Responses API. Not yet implemented. */
export declare function createOpenAIPort(model: Model): ModelPort;
