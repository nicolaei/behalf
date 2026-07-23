import { describe, it, expect } from "vitest";
import { agentTurn, runFlow, runtime, provide, tool, userText } from "../../index.js";
import { memoryStore } from "@behalf-js/stores";
import type { Model, ModelPort, Profile } from "../../index.js";
import { assistantToolCall, assistantText } from "./support.js";

// agentTurn's default finish condition is [{ on: "finalMessage" }] — the turn
// used no tools. `finishOn` overrides that with one or more conditions; the
// turn ends the moment any of them matches. `{ on: "toolCall", name }` ends
// the turn as soon as that named tool is called, and agentTurn's own output
// becomes that tool's own result (not the model's text) — so a caller can
// consume structured data straight out of a "submit"-style tool. Non-listed
// tool calls (e.g. an "ask" tool) just loop as usual, unaffected.

const MODEL: Model = {
  identifier: "scripted",
  provider: "test",
  contextWindow: 1000,
  reasoning: [],
};

describe("agentTurn finishOn", () => {
  it("finishes as soon as the named tool is called, with no second model call", async () => {
    const submitSpec = tool<{ page: string }, { ok: true; page: string }>(
      "submitSpec",
      "Submit the page spec.",
    );
    const profile: Profile = { model: MODEL, system: "asker", tools: [submitSpec] };
    let calls = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: () => {
        calls += 1;
        return Promise.resolve(assistantToolCall("submitSpec", { page: "counter" }));
      },
    };

    const ready = await runtime({
      models: () => port,
      bindings: [provide(submitSpec, (input) => Promise.resolve({ ok: true, page: input.page }))],
      store: memoryStore(),
    });

    const result = await runFlow(
      agentTurn(profile, { finishOn: [{ on: "toolCall", name: "submitSpec" }] }),
      userText("what page?"),
      ready,
    );

    expect(calls).toBe(1); // finished right after the one tool call, no follow-up model call
    expect(result).toMatchObject({
      finishedBy: "toolCall",
      name: "submitSpec",
      output: { ok: true, page: "counter" },
    });
  });

  it("loops as usual when a different tool is called, only finishing on a listed one", async () => {
    const ask = tool<{ question: string }, { answer: string }>("ask", "Ask the user.");
    const submitSpec = tool<{ page: string }, { ok: true; page: string }>(
      "submitSpec",
      "Submit the page spec.",
    );
    const profile: Profile = { model: MODEL, system: "asker", tools: [ask, submitSpec] };
    let calls = 0;
    const port: ModelPort = {
      model: MODEL,
      respond: () => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve(assistantToolCall("ask", { question: "which page?" }));
        return Promise.resolve(assistantToolCall("submitSpec", { page: "counter" }));
      },
    };

    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(ask, () => Promise.resolve({ answer: "counter" })),
        provide(submitSpec, (input) => Promise.resolve({ ok: true, page: input.page })),
      ],
      store: memoryStore(),
    });

    const result = await runFlow(
      agentTurn(profile, { finishOn: [{ on: "toolCall", name: "submitSpec" }] }),
      userText("what page?"),
      ready,
    );

    expect(calls).toBe(2);
    expect(result).toMatchObject({ finishedBy: "toolCall", name: "submitSpec" });
  });

  it("finishes on whichever listed tool call actually happens, out of several", async () => {
    const submitSpec = tool<{ page: string }, { ok: true }>("submitSpec", "Submit.");
    const cancel = tool<Record<string, never>, { ok: true }>("cancel", "Cancel.");
    const profile: Profile = { model: MODEL, system: "asker", tools: [submitSpec, cancel] };
    const port: ModelPort = {
      model: MODEL,
      respond: () => Promise.resolve(assistantToolCall("cancel", {})),
    };

    const ready = await runtime({
      models: () => port,
      bindings: [
        provide(submitSpec, () => Promise.resolve({ ok: true })),
        provide(cancel, () => Promise.resolve({ ok: true })),
      ],
      store: memoryStore(),
    });

    const result = await runFlow(
      agentTurn(profile, {
        finishOn: [
          { on: "toolCall", name: "submitSpec" },
          { on: "toolCall", name: "cancel" },
        ],
      }),
      userText("nevermind"),
      ready,
    );

    expect(result).toMatchObject({ finishedBy: "toolCall", name: "cancel" });
  });

  it("still finishes on a final message when finishOn's tool is never called", async () => {
    const submitSpec = tool<{ page: string }, { ok: true; page: string }>(
      "submitSpec",
      "Submit the page spec.",
    );
    const profile: Profile = { model: MODEL, system: "asker", tools: [submitSpec] };
    const port: ModelPort = {
      model: MODEL,
      respond: () => Promise.resolve(assistantText("what page do you want?")),
    };

    const ready = await runtime({
      models: () => port,
      bindings: [provide(submitSpec, (input) => Promise.resolve({ ok: true, page: input.page }))],
      store: memoryStore(),
    });

    const result = await runFlow(
      agentTurn(profile, { finishOn: [{ on: "toolCall", name: "submitSpec" }] }),
      userText("hi"),
      ready,
    );

    expect(result).toEqual({ finishedBy: "finalMessage", text: "what page do you want?" });
  });

  it("defaults to [{ on: 'finalMessage' }] when finishOn is omitted", async () => {
    const port: ModelPort = {
      model: MODEL,
      respond: () => Promise.resolve(assistantText("hello")),
    };
    const profile: Profile = { model: MODEL, system: "agent", tools: [] };
    const ready = await runtime({
      models: () => port,
      bindings: [],
      store: memoryStore(),
    });

    const result = await runFlow(agentTurn(profile), userText("hi"), ready);

    expect(result).toEqual({ finishedBy: "finalMessage", text: "hello" });
  });
});
