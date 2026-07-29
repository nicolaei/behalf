// Flow authoring — agentTurn. See docs/reference.md.
//
// Reusable graph primitive: run a model, wait for every tool call it made,
// fold their results into one combined message, loop back to the model.
// `finishOn` (default: [{ on: "finalMessage" }]) controls when the turn ends:
// a turn that used no tools always finishes with the assistant's final text,
// regardless of `finishOn` — that's the built-in "no tools this turn" path.
// On top of that, an `{ on: "toolCall", name }` entry ends the turn the
// instant a tool call by that name fires (even if other tool calls happened
// in the same turn), outputting that call's own resolved result instead of
// looping back to the model. Tool calls not named by any `finishOn` entry
// still run and fold into the thread exactly as before — `finishOn` only
// changes when the turn ends and what it outputs, never which tool calls
// get executed.
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
import type { Message, ContentBlock } from "./message.js";

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

/**
 * A finish condition for `agentTurn` — the turn ends the moment any listed
 * condition matches this turn's response. `"finalMessage"` (a turn used no
 * tools) is always active regardless of `finishOn`; `"toolCall"` additionally
 * ends the turn the instant the named tool is called.
 * @public
 */
export type FinishOn = { on: "finalMessage" } | { on: "toolCall"; name: string };

/** Options for `agentTurn`. @public */
export interface AgentTurnOptions {
  /**
   * Conditions that end the turn; the turn ends the moment any one matches
   * this turn's response. Default when omitted: `[{ on: "finalMessage" }]` —
   * today's "no tool calls" behavior.
   */
  finishOn?: FinishOn[];
}

/** What `agentTurn` produces once its finish condition is met. @public */
export type AgentTurnResult =
  | { finishedBy: "finalMessage"; text: string }
  | { finishedBy: "toolCall"; name: string; correlationId: string; output: unknown };

/** A resolved tool call from the turn's own toolResult message, matched back to its name. */
interface FiredToolCall {
  name: string;
  correlationId: string;
  output: unknown;
}

/** Reads the last assistant message (its toolCall blocks) and the tool message that just
 * followed it (its toolResult blocks) straight off the thread, and returns each fired call
 * paired with its own name and result — no data carried in from earlier steps, since a
 * `compact` emit's routed output is `undefined` downstream (see step-runner.ts/drive.ts). */
function firedToolCalls(messages: Message[]): FiredToolCall[] {
  const toolMessage = messages.at(-1);
  if (toolMessage?.role !== "tool") return [];
  let assistantMessage: Message | undefined;
  for (let i = messages.length - 2; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (candidate?.role === "assistant") {
      assistantMessage = candidate;
      break;
    }
  }
  if (!assistantMessage) return [];
  const nameByCorrelationId = new Map(
    assistantMessage.content
      .filter(
        (block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
      )
      .map((block) => [block.correlationId, block.name]),
  );
  return toolMessage.content
    .filter(
      (block): block is Extract<typeof block, { type: "toolResult" }> =>
        block.type === "toolResult",
    )
    .flatMap((block) => {
      const name = nameByCorrelationId.get(block.correlationId);
      return name ? [{ name, correlationId: block.correlationId, output: block.output }] : [];
    });
}

// --- maybeCompact's policy: a rough estimate, a threshold, and a placeholder summary. ---
// No tokenizer dependency exists in this repo today, and adding one is out of scope for
// this step: chars/4 is the well-known ballpark approximation for English text used by
// most "rough token count" heuristics, and it needs no model-specific vocabulary.
const CHARS_PER_TOKEN_ESTIMATE = 4;
// 8000 tokens is a conservative slice of even a small (e.g. 32k-context) model's window —
// comfortably clear of the budget before the thread risks crowding out the model's own
// reply, while still leaving many turns' worth of headroom before compaction ever fires.
const TOKEN_BUDGET = 8000;
// How many of the most recent messages survive a compaction verbatim. 10 is enough to keep
// the immediately preceding exchange (a model reply plus the tool round-trip that produced
// it) intact, so the model doesn't lose short-term continuity right when it compacts.
const KEEP_LAST = 10;

function blockLength(block: ContentBlock): number {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text.length;
    case "image":
      return block.data.length;
    case "toolCall":
      return block.name.length + JSON.stringify(block.input ?? "").length;
    case "toolResult":
      return JSON.stringify(block.output ?? "").length;
  }
}

/** Rough token estimate over a thread's messages — no tokenizer, chars/4 ballpark. */
function estimateTokens(messages: Message[]): number {
  const chars = messages.reduce(
    (total, message) => total + message.content.reduce((sum, block) => sum + blockLength(block), 0),
    0,
  );
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

function overBudget(estimate: number): boolean {
  return estimate > TOKEN_BUDGET;
}

/**
 * NAIVE PLACEHOLDER — not a real summarization. Real summarization (an actual model call
 * that reads the thread and writes a faithful digest) is out of scope for this step; only
 * the compaction mechanism (estimate -> threshold -> compact()) is. This just states how
 * many messages got folded away, so downstream context loss is at least honest, not silent.
 */
function summarize(messages: Message[]): Message {
  return {
    role: "system",
    content: [
      {
        type: "text",
        text: `[naive summary, not model-generated] Compacted ${String(messages.length)} earlier messages.`,
      },
    ],
  };
}

/**
 * A reusable graph: run the model, wait for its tool calls, fold results, loop until a
 * finish condition matches. One agent's turn — the loop that keeps it going until it stops.
 * @public
 */
export function agentTurn(profile: Profile, options?: AgentTurnOptions): Graph {
  const finishOnToolNames = new Set(
    (options?.finishOn ?? [])
      .filter(
        (condition): condition is Extract<FinishOn, { on: "toolCall" }> =>
          condition.on === "toolCall",
      )
      .map((condition) => condition.name),
  );

  return defineGraph("agent-turn", (flow) => {
    const respond = flow.step(async (context) => context.output(await context.modelCall(profile)));
    const each = flow.forEach((output) => (output as ModelCallResult).toolCalls, toolBranch);
    const fold = flow.step((context) => {
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
      // assertions) see a single "message"-typed record per turn. fold only combines
      // and logs — it never decides whether to compact; that's maybeCompact's job below.
      context.appendEvent({ message: toolMessage }, "message");
      return Promise.resolve(context.output(true));
    });
    // Estimate-based compaction check, run every time fold merges tool results into the
    // thread — computed over context.thread.messages directly, with no model call involved,
    // so it can decide before the loop ever asks the model to respond again. Most turns the
    // thread is under budget and shouldCompact is false; nothing happens.
    const maybeCompact = flow.step(async (context) => {
      const estimate = estimateTokens(context.thread.messages);
      const shouldCompact = overBudget(estimate);
      if (shouldCompact) {
        await context.compact({ summary: summarize(context.thread.messages), keepLast: KEEP_LAST });
      }
      return context.output(shouldCompact);
    });
    const checkFinish = flow.step(
      outputs((context) => {
        if (finishOnToolNames.size === 0) return { winner: undefined };
        const winner = firedToolCalls(context.thread.messages).find((call) =>
          finishOnToolNames.has(call.name),
        );
        return { winner };
      }),
    );
    const finishByTool = flow.step(
      outputs((context) => {
        const { winner } = context.inputs[0] as { winner: FiredToolCall };
        const result: AgentTurnResult = {
          finishedBy: "toolCall",
          name: winner.name,
          correlationId: winner.correlationId,
          output: winner.output,
        };
        return result;
      }),
    );
    const finalize = flow.step(
      outputs((context) => {
        const last = context.thread.messages.at(-1);
        const block = last?.content.find((candidate) => candidate.type === "text");
        const result: AgentTurnResult = {
          finishedBy: "finalMessage",
          text: block?.type === "text" ? block.text : "",
        };
        return result;
      }),
    );

    flow.entry(respond);
    respond.then(each);
    each.when((results) => (results as unknown[]).length > 0, fold).otherwise(finalize);
    fold.then(maybeCompact);
    maybeCompact.then(checkFinish);
    checkFinish
      .when((output) => (output as { winner?: FiredToolCall }).winner !== undefined, finishByTool)
      .otherwise(respond);
    finishByTool.then(flow.finish);
    finalize.then(flow.finish);
  });
}
