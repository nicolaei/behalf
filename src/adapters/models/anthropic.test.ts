// Unit tests for the pure helpers in anthropic.ts. No network — auth resolution,
// message mapping, and usage mapping are all literal data in/out.

import { describe, it, expect } from "vitest";
import {
  resolveAuth,
  toAnthropicRequest,
  fromAnthropicBlock,
  fromAnthropicUsage,
  oauthHeaders,
  CLAUDE_CODE_IDENTITY,
} from "./anthropic.js";
import type { Profile } from "../../flow/profile.js";
import type { Message } from "../../flow/message.js";
import type { Model } from "../../flow/model.js";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { tool } from "../../flow/tool.js";

const model: Model = {
  identifier: "claude-opus-4-8",
  provider: "anthropic",
  contextWindow: 200_000,
  reasoning: ["off", "medium"],
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return { model, system: "test persona", tools: [], ...overrides };
}

describe("resolveAuth", () => {
  it("prefers CLAUDE_CODE_OAUTH_TOKEN when set", () => {
    expect(
      resolveAuth({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok", ANTHROPIC_API_KEY: "api-key" }),
    ).toEqual({ mode: "oauth", token: "oauth-tok" });
  });

  it("falls back to ANTHROPIC_API_KEY when no oauth token is set", () => {
    expect(resolveAuth({ ANTHROPIC_API_KEY: "api-key" })).toEqual({
      mode: "apiKey",
      key: "api-key",
    });
  });

  it("throws a clear error when neither credential is set", () => {
    expect(() => resolveAuth({})).toThrow(/No Anthropic credentials found/);
  });
});

describe("toAnthropicRequest", () => {
  it("maps a system prompt and one user text message", () => {
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile(), messages);

    expect(request.system).toBe("test persona");
    expect(request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(request.thinking).toBeUndefined();
  });

  it("folds a multi-turn history with an assistant tool call and a tool result back in", () => {
    const messages: Message[] = [
      {
        role: "user",
        intent: "standard",
        content: [{ type: "text", text: "what's the weather?" }],
      },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: { input: 10, output: 5 },
        content: [
          {
            type: "toolCall",
            correlationId: "call-1",
            name: "get_weather",
            input: { city: "nyc" },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "toolResult", correlationId: "call-1", output: { tempF: 72 } }],
      },
    ];

    const request = toAnthropicRequest(profile(), messages);

    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "what's the weather?" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "get_weather", input: { city: "nyc" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: JSON.stringify({ tempF: 72 }) },
        ],
      },
    ]);
  });

  it("passes thinking config when the profile enables reasoning", () => {
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile({ reasoning: "medium" }), messages);

    expect(request.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("carries a thinking block's signature through unmodified", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-4-8",
        usage: { input: 1, output: 1 },
        content: [{ type: "thinking", text: "reasoning...", signature: "sig-123" }],
      },
    ];

    const request = toAnthropicRequest(profile(), messages);

    expect(request.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "reasoning...", signature: "sig-123" }],
      },
    ]);
  });

  it("prepends the Claude Code identity block first when isOAuth is true", () => {
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile(), messages, true);

    expect(request.system.startsWith(CLAUDE_CODE_IDENTITY)).toBe(true);
    expect(request.system).toBe(`${CLAUDE_CODE_IDENTITY}\n\ntest persona`);
  });

  it("omits the Claude Code identity block when isOAuth is false (the default)", () => {
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile(), messages);

    expect(request.system).toBe("test persona");
    expect(request.system).not.toContain("Claude Code");
  });
});

describe("toAnthropicRequest — tools", () => {
  it("includes a tools array built from profile.tools, with a real JSON schema", () => {
    const search = tool<{ query: string }, { hits: string[] }>(
      "search",
      "Search the web.",
      z.object({ query: z.string() }),
    );
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile({ tools: [search] }), messages);

    expect(request.tools).toEqual([
      {
        name: "search",
        description: "Search the web.",
        input_schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("omits the tools key entirely when profile.tools is empty", () => {
    const messages: Message[] = [
      { role: "user", intent: "standard", content: [{ type: "text", text: "hi" }] },
    ];

    const request = toAnthropicRequest(profile(), messages);

    expect(request.tools).toBeUndefined();
  });
});

describe("fromAnthropicBlock", () => {
  it("maps a text block", () => {
    expect(fromAnthropicBlock({ type: "text", text: "hi", citations: null })).toEqual({
      type: "text",
      text: "hi",
    });
  });

  it("maps a thinking block, carrying the signature through", () => {
    expect(
      fromAnthropicBlock({
        type: "thinking",
        thinking: "reasoning...",
        signature: "sig-123",
      }),
    ).toEqual({ type: "thinking", text: "reasoning...", signature: "sig-123" });
  });

  it("maps a redacted_thinking block, keeping the opaque payload in signature", () => {
    expect(
      fromAnthropicBlock({
        type: "redacted_thinking",
        data: "encrypted-blob",
      }),
    ).toEqual({ type: "thinking", text: "", signature: "encrypted-blob", redacted: true });
  });

  it("maps a tool_use block", () => {
    expect(
      fromAnthropicBlock({
        type: "tool_use",
        id: "call-1",
        name: "get_weather",
        input: { city: "nyc" },
      } as Anthropic.ContentBlock),
    ).toEqual({
      type: "toolCall",
      correlationId: "call-1",
      name: "get_weather",
      input: { city: "nyc" },
    });
  });
});

describe("fromAnthropicUsage", () => {
  it("maps a literal Anthropic usage object", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      output_tokens_details: { thinking_tokens: 20 },
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 10,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
    } as Anthropic.Usage;

    expect(fromAnthropicUsage(usage)).toEqual({
      input: 100,
      output: 50,
      reasoning: 20,
      cacheRead: 30,
      cacheWrite: 10,
    });
  });

  it("omits optional fields the response doesn't report", () => {
    const usage = {
      input_tokens: 5,
      output_tokens: 3,
      output_tokens_details: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      server_tool_use: null,
    } as Anthropic.Usage;

    expect(fromAnthropicUsage(usage)).toEqual({ input: 5, output: 3 });
  });
});

describe("oauthHeaders", () => {
  it("carries both required beta flags, not just oauth-2025-04-20 alone", () => {
    const headers = oauthHeaders();
    expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(headers["anthropic-beta"]).toContain("claude-code-20250219");
  });

  it("carries the direct-browser-access and cli identity headers OAuth requires", () => {
    const headers = oauthHeaders();
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    expect(headers["x-app"]).toBe("cli");
    expect(headers["user-agent"]).toMatch(/^claude-cli\//);
  });
});
