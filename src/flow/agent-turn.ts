// Flow authoring — agentTurn. See docs/reference.md.
//
// Reusable graph primitive: run a model, wait for every tool call it made,
// fold their results into one combined message, loop back to the model.
// Finishes with the assistant's final text once a turn makes no tool calls.
// This generalizes the hand-rolled pattern in
// src/tests/acceptance/agent-loop.test.ts's own scriptedFixture() (that
// file's name predates this rename — it still calls its own local fixture
// "agentLoop", a private variable, not this exported primitive).

import { defineGraph } from "./graph.js";
import type { Graph } from "./graph.js";
import { outputs } from "./step.js";
import type { ModelCallResult, WaitForResult } from "./step.js";
import { toolCall } from "./waitable.js";
import type { Profile } from "./profile.js";
import type { Message } from "./message.js";

function toolBranch(item: unknown): Graph {
  const { correlationId } = item as { correlationId: string; name: string };
  return defineGraph(`agent-turn-tool-${correlationId}`, (flow) => {
    const wait = flow.waitFor(toolCall(correlationId));
    const shape = flow.step(
      outputs((context) => {
        const result = context.inputs[0] as WaitForResult;
        return { correlationId, output: result.result };
      }),
    );
    flow.entry(wait);
    wait.then(shape);
    shape.then(flow.finish);
  });
}

/** A reusable graph: run the model, wait for its tool calls, fold results, loop. One agent's turn — the loop that keeps it going until it stops using tools. @public */
export function agentTurn(profile: Profile): Graph {
  return defineGraph("agent-turn", (flow) => {
    const respond = flow.step(async (context) => context.output(await context.modelCall(profile)));
    const each = flow.forEach((output) => (output as ModelCallResult).toolCalls, toolBranch);
    const foldAndLoop = flow.step(async (context) => {
      const results = context.inputs[0] as { correlationId: string; output: unknown }[];
      const toolMessage: Message = {
        role: "tool",
        content: results.map((result) => ({
          type: "toolResult" as const,
          correlationId: result.correlationId,
          output: result.output,
        })),
      };
      // One combined event so downstream consumers (and this primitive test's own log
      // assertions) see a single "message"-typed record per turn — separate from the
      // "compaction" event `compact()` itself logs, which folds it into the thread so
      // the next modelCall actually sees it.
      context.appendEvent({ message: toolMessage }, "message");
      return context.compact((messages) => Promise.resolve([...messages, toolMessage]));
    });
    const finalize = flow.step(
      outputs((context) => {
        const last = context.thread.messages.at(-1);
        const block = last?.content.find((candidate) => candidate.type === "text");
        return block?.type === "text" ? block.text : "";
      }),
    );

    flow.entry(respond);
    respond.then(each);
    each.when((results) => (results as unknown[]).length > 0, foldAndLoop).otherwise(finalize);
    foldAndLoop.then(respond);
    finalize.then(flow.finish);
  });
}
