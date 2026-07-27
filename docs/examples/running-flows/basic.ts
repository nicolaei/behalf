// The Learn "Running flows" page's example: assembling a runtime, checking
// coverage with satisfiesFlows before running anything, and running a flow
// with runFlow. Driven with the library's own fakePort (@behalf-js/testing),
// so its behavior (a clean coverage check, a deliberately-missing one, and a
// real run) is exercised by basic.test.ts, not just typechecked.

import { defineGraph, userText, runtime, runFlow, satisfiesFlows, tool } from "@behalf-js/core";
import type { Profile, Graph, StepContext } from "@behalf-js/core";
import { fakePort } from "@behalf-js/testing";
import { memoryStore } from "@behalf-js/stores";

function lastAssistantText(context: StepContext): string {
  const last = context.thread.messages.at(-1);
  const block =
    last?.role === "assistant" ? last.content.find((b) => b.type === "text") : undefined;
  return block?.type === "text" ? block.text : "";
}

const assistant: Profile = {
  model: fakePort.model,
  system: "You are a helpful assistant.",
  tools: [],
};

// A step tagged with `.persona` is how satisfiesFlows finds a model call
// statically, with no execution: the same tag context.modelCall's caller
// attaches by hand, so the graph needs no separate persona registration.
const respond = Object.assign(
  async (context: StepContext) => {
    await context.modelCall(assistant);
    return context.output({ reply: lastAssistantText(context) });
  },
  { persona: assistant },
);

export const chat: Graph = defineGraph("chat", (flow) => {
  const turn = flow.step(respond);
  flow.entry(turn);
  turn.then(flow.finish);
});

// #region runtime
export const ready = await runtime({
  models: () => fakePort,
  bindings: [],
  store: memoryStore(),
});
// #endregion runtime

// #region coverage
export const missing = satisfiesFlows([chat], () => fakePort, []);

// A persona that declares a tool with no matching binding, so satisfiesFlows
// has something real to report.
const lookupOrder = tool<{ orderId: string }, { status: string }>(
  "lookup_order",
  "Looks up an order's shipping status by id",
);
const needsLookup: Profile = { model: fakePort.model, system: "support", tools: [lookupOrder] };
const brokenRespond = Object.assign(
  async (context: StepContext) => {
    await context.modelCall(needsLookup);
    return context.output({ reply: lastAssistantText(context) });
  },
  { persona: needsLookup },
);
const brokenChat: Graph = defineGraph("broken-chat", (flow) => {
  const turn = flow.step(brokenRespond);
  flow.entry(turn);
  turn.then(flow.finish);
});

export const missingTool = satisfiesFlows([brokenChat], () => fakePort, []);
// #endregion coverage

// #region run-flow
export const result = await runFlow(chat, userText("Say hello."), ready);
// #endregion run-flow
