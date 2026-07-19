// Adapter — a ModelPort that returns a canned response. For acceptance tests.

import type { ModelPort } from "../../engine/model-port.js";

const fakeModel = {
  identifier: "fake",
  provider: "fake",
  contextWindow: 128_000,
  reasoning: [],
};

/** Always replies with a fixed text message and no tool calls. @public */
export const fakePort: ModelPort = {
  model: fakeModel,
  respond: () =>
    Promise.resolve({
      role: "assistant",
      provider: fakeModel.provider,
      model: fakeModel.identifier,
      content: [{ type: "text", text: "ok" }],
      usage: { input: 1, output: 1 },
    }),
};
