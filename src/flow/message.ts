// Flow authoring — Message. See docs/reference.md § "Message".

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

export type Intent = "standard" | "steering" | "abort";

/** The routing label `waitFor`/`interrupt` match on. Flow authors define their own values. */
export type MessageKind = string;

export type Message =
  | { role: "system"; content: ContentBlock[] }
  | { role: "user"; content: ContentBlock[]; intent: Intent; kind?: MessageKind }
  | { role: "assistant"; content: ContentBlock[]; provider: string; model: string; usage: Usage }
  | { role: "tool"; content: ContentBlock[] };

export type UserMessage = Extract<Message, { role: "user" }>;
export type AssistantMessage = Extract<Message, { role: "assistant" }>;

export interface Usage {
  input: number;
  output: number; // includes reasoning tokens
  reasoning?: number; // thinking/reasoning tokens (Anthropic thinking_tokens · OpenAI reasoning_tokens)
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number; // 0 for free/local, absent when unknown
}
