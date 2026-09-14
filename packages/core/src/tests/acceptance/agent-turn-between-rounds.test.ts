import { describe, expect, it } from "vitest";
import { agentTurn, ai, outputs, provide, runtime, tool, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import { runToCompletion } from "@behalf-js/testing";
import type { AssistantMessage, Message, Model, ModelPort, Profile } from "../../index.js";
import { assistantText, assistantToolCall, textOf } from "./support.js";

// `betweenRounds` is the seam a caller uses to do something BETWEEN the rounds
// of one turn — after a tool round has folded, before the model is asked again.
// Cockpit's use of it is steering: a message the human typed while the agent was
// working gets folded onto the thread so the NEXT model call sees it, rather than
// waiting for the whole turn to end.
//
// Where it sits is the whole of its contract, so these tests pin its edges:
// it runs on the loopback and only there. A turn that ends — on a final message,
// or early on a `finishOn` tool call — never reaches it.

const MODEL: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

const STEER = "actually, use the fast path";

/** A port that answers from a fixed list and remembers the thread each call was handed. */
function recordingPort(replies: AssistantMessage[]): {
  port: ModelPort;
  handed: string[][];
} {
  const handed: string[][] = [];
  let cursor = 0;
  const port: ModelPort = {
    model: MODEL,
    respond: (_profile, messages) => {
      handed.push(messages.map(asText));
      const reply = replies[cursor++];
      if (!reply) throw new Error("scripted port exhausted");
      return Promise.resolve(reply);
    },
  };
  return { port, handed };
}

/** One message as an assertion can read it: its role, and the text it carries. */
function asText(message: Message): string {
  return `${message.role}:${textOf(message)}`;
}

/** The steer a `betweenRounds` hook folds in, as the thread each visit saw. */
function steeringHook(seen: string[][]) {
  return outputs((context) => {
    seen.push(context.thread.messages.map(asText));
    context.appendEvent(
      {
        message: {
          role: "user",
          intent: "steering",
          content: [{ type: "text", text: STEER }],
        },
      },
      "message",
    );
    return undefined;
  });
}

describe("agentTurn betweenRounds", () => {
  it("runs the hook after the round folded and before the next model call", async () => {
    const ping = tool<Record<string, never>, string>("ping", "Ping.");
    const profile: Profile = { model: MODEL, system: "agent", tools: [ping] };
    const { port, handed } = recordingPort([
      assistantToolCall("ping", {}),
      assistantText("done, the fast way"),
    ]);
    const seen: string[][] = [];

    const ready = await runtime({
      store: memoryStore(),
      extensions: [
        ai({ models: () => port, bindings: [provide(ping, () => Promise.resolve("pong"))] }),
      ],
    });

    const result = await runToCompletion(
      agentTurn(profile, { betweenRounds: steeringHook(seen) }),
      userText("do the thing"),
      ready,
    );

    // Once, on the loopback — not before the first call, and not after the last.
    expect(seen).toHaveLength(1);

    // It saw the round that had just folded, and not its own message yet.
    expect(seen[0]).toEqual(["user:do the thing", "assistant:", "tool:"]);
    expect(seen[0]?.some((text) => text.includes(STEER))).toBe(false);

    // And the model's second call saw the steer, after the tool result.
    expect(handed).toHaveLength(2);
    expect(handed[0]?.some((text) => text.includes(STEER))).toBe(false);
    expect(handed[1]).toEqual(["user:do the thing", "assistant:", "tool:", `user:${STEER}`]);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "done, the fast way" });
  });

  it("never runs when the turn ends on a final message", async () => {
    const profile: Profile = { model: MODEL, system: "agent", tools: [] };
    const { port } = recordingPort([assistantText("hello")]);
    const seen: string[][] = [];

    const ready = await runtime({
      store: memoryStore(),
      extensions: [ai({ models: () => port, bindings: [] })],
    });

    const result = await runToCompletion(
      agentTurn(profile, { betweenRounds: steeringHook(seen) }),
      userText("hi"),
      ready,
    );

    expect(seen).toHaveLength(0);
    expect(result).toEqual({ finishedBy: "finalMessage", text: "hello" });
  });

  it("never runs when a finishOn tool ends the turn early", async () => {
    const submit = tool<{ page: string }, { ok: true; page: string }>("submit", "Submit.");
    const profile: Profile = { model: MODEL, system: "agent", tools: [submit] };
    const { port } = recordingPort([assistantToolCall("submit", { page: "counter" })]);
    const seen: string[][] = [];

    const ready = await runtime({
      store: memoryStore(),
      extensions: [
        ai({
          models: () => port,
          bindings: [provide(submit, (input) => Promise.resolve({ ok: true, page: input.page }))],
        }),
      ],
    });

    const result = await runToCompletion(
      agentTurn(profile, {
        finishOn: [{ on: "toolCall", name: "submit" }],
        betweenRounds: steeringHook(seen),
      }),
      userText("what page?"),
      ready,
    );

    expect(seen).toHaveLength(0);
    expect(result).toMatchObject({ finishedBy: "toolCall", name: "submit" });
  });
});
