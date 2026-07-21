// Adapter — Anthropic ModelPort. See docs/reference.md § "ModelPort" (opus48 sketch).
//
// Split into small pure helpers (auth resolution, request/response mapping, usage
// mapping) plus the createAnthropicPort factory that wires them to the real
// @anthropic-ai/sdk client. The pure helpers are unit tested directly with no
// network; createAnthropicPort itself is exercised only by manual/example use.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Model } from "../../flow/model.js";
import type { ModelPort } from "../../engine/model-port.js";
import type { Profile } from "../../flow/profile.js";
import type { Tool, Toolset } from "../../flow/tool.js";
import type { ContentBlock, Message, AssistantMessage, Usage } from "../../flow/message.js";

/** One round-trip token round trip: a resolved credential mode for the Anthropic API. @public */
export type AnthropicAuth = { mode: "oauth"; token: string } | { mode: "apiKey"; key: string };

/**
 * Picks the credential mode from the environment. `CLAUDE_CODE_OAUTH_TOKEN`
 * (from `claude setup-token`) wins over `ANTHROPIC_API_KEY`; neither present
 * is a hard error since there is no way to call the API at all.
 * @public
 */
export function resolveAuth(env: Record<string, string | undefined>): AnthropicAuth {
  const oauthToken = env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (oauthToken) return { mode: "oauth", token: oauthToken };

  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey) return { mode: "apiKey", key: apiKey };

  throw new Error(
    "No Anthropic credentials found — set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.",
  );
}

// OAuth (Claude Pro/Max subscription) tokens are scoped to Claude Code's own
// client identity — Anthropic's API requires the request to present as Claude
// Code, both via these headers and the system-prompt identity block
// `toAnthropicRequest` prepends in OAuth mode, or it rejects/mishandles an
// OAuth-authenticated call. The SDK's `authToken` option alone only sends the
// bearer token; it does NOT add these headers itself — verified against a real
// implementation: https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/anthropic-messages.ts
const CLAUDE_CODE_VERSION = "2.1.75";
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** The headers an OAuth-mode request must carry so Anthropic accepts it as a Claude Code client. Pure, so it's unit tested with no network. @public */
export function oauthHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}`,
    "x-app": "cli",
  };
}

/** Builds the SDK client for a resolved auth mode. OAuth mode uses the SDK's `authToken` option plus `oauthHeaders()` and `dangerouslyAllowBrowser` (required for the SDK to allow sending a bearer token outside its normal apiKey path). */
export function createAnthropicClient(auth: AnthropicAuth): Anthropic {
  if (auth.mode === "apiKey") return new Anthropic({ apiKey: auth.key });
  return new Anthropic({
    apiKey: null,
    authToken: auth.token,
    dangerouslyAllowBrowser: true,
    defaultHeaders: oauthHeaders(),
  });
}

const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_THINKING_BUDGET = 4096;

/** Thinking token budgets by reasoning level — deliberately coarse, not over-engineered. */
const THINKING_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
};

/** The shape `toAnthropicRequest` hands to `client.messages.create`. */
export interface AnthropicRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  thinking?: Anthropic.ThinkingConfigParam;
  tools?: Anthropic.Tool[];
}
/** OAuth (Claude Pro/Max subscription) tokens are scoped to Claude Code's own tool surface — these are the exact tool names it will accept. @public */
export const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
] as const;

const ccToolLookup = new Map(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

/** Renames a tool name to Claude Code's canonical casing when it matches one exactly (case-insensitive); otherwise passes it through unchanged. @public */
export function toClaudeCodeName(name: string): string {
  return ccToolLookup.get(name.toLowerCase()) ?? name;
}

/** Reverses a Claude Code canonical name back to whichever of the caller's own registered tool names matches it (case-insensitive); otherwise passes it through unchanged. @public */
export function fromClaudeCodeName(name: string, toolNames: readonly string[]): string {
  const lowerName = name.toLowerCase();
  const matched = toolNames.find((toolName) => toolName.toLowerCase() === lowerName);
  return matched ?? name;
}

/** Maps a `behalf` Tool/Toolset to Anthropic's per-tool definition shape. Toolset members are resolved dynamically elsewhere and never statically known here, so a Toolset falls back to a permissive schema. */
function toAnthropicToolDef(t: Tool | Toolset, isOAuth = false): Anthropic.Tool {
  const schema = "schema" in t ? t.schema : z.record(z.string(), z.unknown());
  return {
    name: isOAuth ? toClaudeCodeName(t.name) : t.name,
    description: t.describe,
    input_schema: z.toJSONSchema(schema) as Anthropic.Tool.InputSchema,
  };
}

/**
 * Maps one `behalf` content block to its Anthropic request-side param. Shared
 * by the request and response mapping — the shapes are symmetric enough that
 * a single switch covers both directions for text/thinking/toolCall; toolResult
 * only ever appears in a request (the model never emits one).
 */
function toAnthropicBlock(block: ContentBlock, isOAuth = false): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      if (block.redacted) {
        return { type: "redacted_thinking", data: block.signature ?? "" };
      }
      return { type: "thinking", thinking: block.text, signature: block.signature ?? "" };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType as Anthropic.Base64ImageSource["media_type"],
          data: block.data,
        },
      };
    case "toolCall":
      return {
        type: "tool_use",
        id: block.correlationId,
        name: isOAuth ? toClaudeCodeName(block.name) : block.name,
        input: block.input,
      };
    case "toolResult":
      return {
        type: "tool_result",
        tool_use_id: block.correlationId,
        content: typeof block.output === "string" ? block.output : JSON.stringify(block.output),
        ...(block.isError !== undefined ? { is_error: block.isError } : {}),
      };
  }
}

/**
 * Maps one `behalf` Message to zero-or-one Anthropic MessageParam. `system`
 * messages return undefined — their text is folded into the top-level
 * `system` string by `toAnthropicRequest`, not sent as a `messages` entry.
 * `tool` messages become a `user`-role message (Anthropic has no separate
 * tool role — tool_result blocks live on user messages).
 */
function toAnthropicMessage(message: Message, isOAuth = false): Anthropic.MessageParam | undefined {
  switch (message.role) {
    case "system":
      return undefined;
    case "user":
      return { role: "user", content: message.content.map((b) => toAnthropicBlock(b, isOAuth)) };
    case "assistant":
      return {
        role: "assistant",
        content: message.content.map((b) => toAnthropicBlock(b, isOAuth)),
      };
    case "tool":
      return { role: "user", content: message.content.map((b) => toAnthropicBlock(b, isOAuth)) };
  }
}

function systemText(block: ContentBlock): string {
  return block.type === "text" ? block.text : block.type === "thinking" ? block.text : "";
}

/**
 * Builds the Anthropic request body from a Profile + Message history.
 * `Profile.system` is the primary system prompt source; any `system`-role
 * Messages in the history (docs/reference.md doesn't rule these out) are
 * appended after it so both land in Anthropic's single top-level `system` param.
 * In OAuth mode, Anthropic requires the Claude Code identity block to lead
 * the system prompt — the token is scoped to that client identity and the API
 * rejects/mishandles requests that don't present as Claude Code.
 */
export function toAnthropicRequest(
  profile: Profile,
  messages: Message[],
  isOAuth = false,
): AnthropicRequest {
  const systemFromHistory = messages
    .filter((m): m is Extract<Message, { role: "system" }> => m.role === "system")
    .map((m) => m.content.map(systemText).join(""))
    .filter((text) => text.length > 0);

  const system = [...(isOAuth ? [CLAUDE_CODE_IDENTITY] : []), profile.system, ...systemFromHistory]
    .filter((text) => text.length > 0)
    .join("\n\n");

  const anthropicMessages = messages
    .map((m) => toAnthropicMessage(m, isOAuth))
    .filter((m): m is Anthropic.MessageParam => m !== undefined);

  const reasoning = profile.reasoning;
  const thinking: Anthropic.ThinkingConfigParam | undefined =
    reasoning && reasoning !== "off"
      ? {
          type: "enabled",
          budget_tokens: THINKING_BUDGETS[reasoning] ?? DEFAULT_THINKING_BUDGET,
        }
      : undefined;

  return {
    system,
    messages: anthropicMessages,
    ...(thinking ? { thinking } : {}),
    ...(profile.tools.length > 0
      ? { tools: profile.tools.map((t) => toAnthropicToolDef(t, isOAuth)) }
      : {}),
  };
}

/**
 * Maps one Anthropic response content block back to a `behalf` ContentBlock —
 * the reverse of `toAnthropicBlock`. Only the block kinds the model can
 * actually emit appear here (no toolResult, no image, no cache_control).
 */
export function fromAnthropicBlock(
  block: Anthropic.ContentBlock,
  options?: { isOAuth?: boolean; toolNames?: readonly string[] },
): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return { type: "thinking", text: block.thinking, signature: block.signature };
    case "redacted_thinking":
      return { type: "thinking", text: "", signature: block.data, redacted: true };
    case "tool_use":
      return {
        type: "toolCall",
        correlationId: block.id,
        name:
          options?.isOAuth && options.toolNames
            ? fromClaudeCodeName(block.name, options.toolNames)
            : block.name,
        input: block.input,
      };
    default:
      // Server-tool blocks (web_search, code_execution, …) have no ContentBlock
      // analogue yet — surface them as opaque text rather than dropping them silently.
      return { type: "text", text: JSON.stringify(block) };
  }
}

/** Maps an Anthropic response's `usage` to `behalf`'s `Usage` shape. @public */
export function fromAnthropicUsage(usage: Anthropic.Usage): Usage {
  const reasoning = usage.output_tokens_details?.thinking_tokens;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(usage.cache_read_input_tokens != null ? { cacheRead: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens != null
      ? { cacheWrite: usage.cache_creation_input_tokens }
      : {}),
  };
}

/**
 * One port per Anthropic model. `respond` makes a single non-streaming call —
 * delta streaming through `stream: DeltaSink` is out of scope here; a follow-up
 * milestone wires token-level streaming through openStream.
 * @public
 */
export function createAnthropicPort(model: Model, client?: Anthropic): ModelPort {
  let auth: AnthropicAuth | undefined;
  let resolvedClient: Anthropic;
  if (client === undefined) {
    auth = resolveAuth(process.env);
    resolvedClient = createAnthropicClient(auth);
  } else {
    resolvedClient = client;
  }
  const isOAuth = auth?.mode === "oauth";

  return {
    model,
    async respond(profile, messages) {
      const request = toAnthropicRequest(profile, messages, isOAuth);
      const response = await resolvedClient.messages.create({
        model: model.identifier,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: request.messages,
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
      });

      const assistantMessage: AssistantMessage = {
        role: "assistant",
        provider: model.provider,
        model: model.identifier,
        content: response.content.map((b) =>
          fromAnthropicBlock(b, { isOAuth, toolNames: profile.tools.map((t) => t.name) }),
        ),
        usage: fromAnthropicUsage(response.usage),
      };
      return assistantMessage;
    },
  };
}
