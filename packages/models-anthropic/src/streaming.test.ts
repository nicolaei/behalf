// Unit test for real delta streaming in createAnthropicPort. No network — a
// fake client's messages.stream() yields a scripted async iterable of raw
// Anthropic stream events, and we assert the exact sequence of stream.delta()
// calls the port produces, plus its final returned AssistantMessage.

import { describe, it, expect } from "vitest";
import { createAnthropicPort } from "./index.js";
import type { Model, Profile, Message, DeltaSink } from "@behalf-js/core";
import type Anthropic from "@anthropic-ai/sdk";

const model: Model = {
  identifier: "claude-opus-4-8",
  provider: "anthropic",
  contextWindow: 200_000,
  reasoning: ["off"],
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return { model, system: "test persona", tools: [], ...overrides };
}

function fakeStreamingClient(events: unknown[]): Anthropic {
  return {
    messages: {
      stream: () => ({
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: () =>
              Promise.resolve(
                i < events.length
                  ? { value: events[i++], done: false }
                  : { value: undefined, done: true },
              ),
          };
        },
      }),
    },
  } as unknown as Anthropic;
}

describe("createAnthropicPort streams real deltas", () => {
  it("emits open/text/close deltas for a single text block, then returns the assembled message", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      },
    ];
    const client = fakeStreamingClient(events);
    const port = createAnthropicPort(model, client);

    const deltas: unknown[] = [];
    const stream: DeltaSink = { delta: (d) => deltas.push(d) };
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const reply = await port.respond(profile(), messages, stream);

    expect(deltas).toEqual([
      { correlationId: "0", open: "text" },
      { correlationId: "0", text: "Hello" },
      { correlationId: "0", text: " world" },
      { correlationId: "0", close: true },
    ]);
    expect(reply.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("emits an open/close pair with a name for a tool_use block, using the block's own id as correlationId", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "search", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
    ];
    const client = fakeStreamingClient(events);
    const port = createAnthropicPort(model, client);

    const deltas: unknown[] = [];
    const stream: DeltaSink = { delta: (d) => deltas.push(d) };
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "weather?" }] },
    ];
    const search = { name: "search", describe: "Search." };

    const reply = await port.respond(profile({ tools: [search] as never }), messages, stream);

    expect(deltas).toEqual([
      { correlationId: "call-1", open: "toolCall", name: "search" },
      { correlationId: "call-1", partialInput: '{"query":"weather"}' },
      { correlationId: "call-1", close: true },
    ]);
    expect(reply.content).toEqual([
      { type: "toolCall", correlationId: "call-1", name: "search", input: { query: "weather" } },
    ]);
  });
});
