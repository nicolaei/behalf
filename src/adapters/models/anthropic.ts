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
import type { DeltaSink } from "../../session/envelope.js";
import { RetryableError } from "../../engine/errors.js";

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

/** `Profile.reasoning` levels mapped to Anthropic's `output_config.effort` — the current
 * API's own vocabulary for thinking effort. `minimal` has no `effort` equivalent; it maps
 * to the lowest real level rather than inventing one. Deliberately coarse, not over-engineered. */
const EFFORT_BY_REASONING: Record<string, Anthropic.OutputConfig["effort"]> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
};

/** The shape `toAnthropicRequest` hands to `client.messages.create`. */
export interface AnthropicRequest {
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  thinking?: Anthropic.ThinkingConfigParam;
  effort?: Anthropic.OutputConfig["effort"];
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
 * In OAuth mode, Anthropic requires `system` to be an array of blocks whose
 * FIRST block is exactly the Claude Code identity string — the endpoint
 * verifies that block verbatim and rejects anything else (including the
 * identity concatenated into a single system string) with a bogus 429
 * rate_limit_error. Verified against the live API.
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

  const rest = [profile.system, ...systemFromHistory]
    .filter((text) => text.length > 0)
    .join("\n\n");

  const system: string | Anthropic.TextBlockParam[] = isOAuth
    ? [
        { type: "text", text: CLAUDE_CODE_IDENTITY },
        ...(rest.length > 0 ? [{ type: "text" as const, text: rest }] : []),
      ]
    : rest;

  const anthropicMessages = messages
    .map((m) => toAnthropicMessage(m, isOAuth))
    .filter((m): m is Anthropic.MessageParam => m !== undefined);

  const reasoning = profile.reasoning;
  // Anthropic's current API (claude-sonnet-5 and later) rejects the older
  // `{type:"enabled", budget_tokens}` shape outright (400: "thinking.type.enabled"
  // is not supported for this model. Use thinking.type.adaptive and
  // output_config.effort") — adaptive+effort is the one shape that works
  // across current models.
  const thinking: Anthropic.ThinkingConfigParam | undefined =
    reasoning && reasoning !== "off" ? { type: "adaptive" } : undefined;
  const effort: Anthropic.OutputConfig["effort"] | undefined =
    reasoning && reasoning !== "off" ? (EFFORT_BY_REASONING[reasoning] ?? "medium") : undefined;

  return {
    system,
    messages: anthropicMessages,
    ...(thinking ? { thinking } : {}),
    ...(effort ? { effort } : {}),
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

/** Maps a streaming `message_delta` event's (possibly partial) usage to `behalf`'s `Usage` shape. Mirrors `fromAnthropicUsage` but tolerates the nullable/partial fields the streaming event carries. */
function usageFromMessageDelta(usage: Partial<Anthropic.MessageDeltaUsage> | undefined): Usage {
  const reasoning = usage?.output_tokens_details?.thinking_tokens;
  return {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(usage?.cache_read_input_tokens != null ? { cacheRead: usage.cache_read_input_tokens } : {}),
    ...(usage?.cache_creation_input_tokens != null
      ? { cacheWrite: usage.cache_creation_input_tokens }
      : {}),
  };
}

/** Anthropic's SDK throws with a numeric `status`; 429 (rate limit) and 5xx (transient server errors) are worth retrying, everything else isn't. @public */
export function isRetryableAnthropicError(cause: unknown): boolean {
  const status = (cause as { status?: number } | undefined)?.status;
  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * One port per Anthropic model. `respond` streams the model's response via
 * `client.messages.stream`, pushing token-level deltas to `stream: DeltaSink`
 * as raw Anthropic stream events arrive, and assembles the equivalent
 * `AssistantMessage` incrementally as blocks close.
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
    async respond(profile, messages, stream: DeltaSink) {
      const request = toAnthropicRequest(profile, messages, isOAuth);
      const toolNames = profile.tools.map((t) => t.name);
      const rawStream = resolvedClient.messages.stream({
        model: model.identifier,
        max_tokens: DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: request.messages,
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
      });

      const correlationIds = new Map<number, string>();
      const blockKinds = new Map<number, "text" | "thinking" | "toolCall">();
      const toolNamesByIndex = new Map<number, string>();
      const textByIndex = new Map<number, string>();
      const partialInputByIndex = new Map<number, string>();
      const signatureByIndex = new Map<number, string>();
      const content: ContentBlock[] = [];
      let usage: Usage = { input: 0, output: 0 };

      try {
        for await (const event of rawStream) {
          switch (event.type) {
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                const correlationId = block.id;
                const name = isOAuth ? fromClaudeCodeName(block.name, toolNames) : block.name;
                correlationIds.set(event.index, correlationId);
                blockKinds.set(event.index, "toolCall");
                toolNamesByIndex.set(event.index, name);
                stream.delta({ correlationId, open: "toolCall", name });
              } else if (block.type === "text") {
                const correlationId = String(event.index);
                correlationIds.set(event.index, correlationId);
                blockKinds.set(event.index, "text");
                stream.delta({ correlationId, open: "text" });
              } else if (block.type === "thinking") {
                const correlationId = String(event.index);
                correlationIds.set(event.index, correlationId);
                blockKinds.set(event.index, "thinking");
                stream.delta({ correlationId, open: "thinking" });
              }
              // Server-tool blocks (web_search, code_execution, …) have no ContentBlock
              // analogue yet — silently skip streaming them, matching fromAnthropicBlock's
              // fallback for the non-streaming path.
              break;
            }
            case "content_block_delta": {
              const correlationId = correlationIds.get(event.index);
              if (correlationId === undefined) break;
              if (event.delta.type === "text_delta") {
                textByIndex.set(
                  event.index,
                  (textByIndex.get(event.index) ?? "") + event.delta.text,
                );
                stream.delta({ correlationId, text: event.delta.text });
              } else if (event.delta.type === "thinking_delta") {
                textByIndex.set(
                  event.index,
                  (textByIndex.get(event.index) ?? "") + event.delta.thinking,
                );
                stream.delta({ correlationId, text: event.delta.thinking });
              } else if (event.delta.type === "input_json_delta") {
                partialInputByIndex.set(
                  event.index,
                  (partialInputByIndex.get(event.index) ?? "") + event.delta.partial_json,
                );
                stream.delta({ correlationId, partialInput: event.delta.partial_json });
              } else if (event.delta.type === "signature_delta") {
                signatureByIndex.set(event.index, event.delta.signature);
              }
              break;
            }
            case "content_block_stop": {
              const correlationId = correlationIds.get(event.index);
              if (correlationId === undefined) break;
              stream.delta({ correlationId, close: true });
              const kind = blockKinds.get(event.index);
              if (kind === "toolCall") {
                const name = toolNamesByIndex.get(event.index) ?? "";
                const rawInput = partialInputByIndex.get(event.index) ?? "";
                content.push({
                  type: "toolCall",
                  correlationId,
                  name,
                  input: JSON.parse(rawInput || "{}"),
                });
              } else if (kind === "text") {
                content.push({ type: "text", text: textByIndex.get(event.index) ?? "" });
              } else if (kind === "thinking") {
                const signature = signatureByIndex.get(event.index);
                content.push({
                  type: "thinking",
                  text: textByIndex.get(event.index) ?? "",
                  ...(signature !== undefined ? { signature } : {}),
                });
              }
              break;
            }
            case "message_delta": {
              usage = usageFromMessageDelta(event.usage);
              break;
            }
            default:
              // message_start/message_stop carry nothing this port needs.
              break;
          }
        }

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          provider: model.provider,
          model: model.identifier,
          content,
          usage,
        };
        return assistantMessage;
      } catch (cause) {
        throw new RetryableError(cause instanceof Error ? cause.message : String(cause), {
          retryable: isRetryableAnthropicError(cause),
          cause,
        });
      }
    },
  };
}
