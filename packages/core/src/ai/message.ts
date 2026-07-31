// Flow authoring — Message. See docs/reference.md § "Message".

/** Union of every content block kind a message can carry. @public */
export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      text: string; // the visible summary; empty when the provider returns encrypted-only
      signature?: string; // one opaque round-trip token: Anthropic signature, OR the OpenAI reasoning item id / encrypted content
      redacted?: boolean; // a safety-redacted block; its opaque payload lives in `signature`
    }
  | { type: "image"; mediaType: string; data: string }
  | { type: "toolCall"; correlationId: string; name: string; input: unknown }
  | { type: "toolResult"; correlationId: string; output: unknown; isError?: boolean };

/** Routing intent for a user message — how the engine treats it on arrival. @public */
export type Intent = "standard" | "steering" | "abort";

/**
 * The routing label `waitFor`/`interrupt` match on. Flow authors define their own values.
 * @public
 */
export type MessageKind = string;

/** Any message that can appear in a thread — system, user, assistant, or tool result. @public */
export type Message =
  | { role: "system"; content: ContentBlock[] }
  | { role: "user"; content: ContentBlock[]; intent: Intent; kind?: MessageKind }
  | { role: "assistant"; content: ContentBlock[]; provider: string; model: string; usage: Usage }
  | { role: "tool"; content: ContentBlock[] };

/** A user-role message — the most common input into the engine. @public */
export type UserMessage = Extract<Message, { role: "user" }>;
/** An assistant-role message carrying provider, model, and usage metadata. @public */
export type AssistantMessage = Extract<Message, { role: "assistant" }>;

/** Token counts and optional cost for one model response. @public */
export interface Usage {
  input: number;
  output: number; // includes reasoning tokens
  reasoning?: number; // thinking/reasoning tokens (Anthropic thinking_tokens · OpenAI reasoning_tokens)
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number; // 0 for free/local, absent when unknown
}

/**
 * Builds a standard user message from plain text — the common case.
 * @public
 */
export function userText(text: string): UserMessage {
  return { role: "user", intent: "standard", content: [{ type: "text", text }] };
}
