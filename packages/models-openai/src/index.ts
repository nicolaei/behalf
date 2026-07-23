// Adapter — OpenAI ModelPort. See docs/reference.md § "ModelPort" (gpt55 sketch).

import type { Model, ModelPort } from "@behalf-js/core";

/** One port per OpenAI model, via the Responses API. Not yet implemented. @public */
export function createOpenAIPort(model: Model): ModelPort {
  void model;
  throw new Error("createOpenAIPort is not implemented yet");
}
