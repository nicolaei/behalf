// Flow authoring — tool / toolset / ToolHandler / provide / expand. See docs/reference.md.

import type { ThreadId } from "./thread.js";
import type { Message } from "./message.js";
import type { Graph } from "./graph.js";
import type { Stream } from "../session/envelope.js";
import type { EventType } from "../session/event.js";

/** One typed capability. `_input`/`_output` are phantom — never populated, used for inference. */
export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly describe: string;
  readonly _input?: Input;
  readonly _output?: Output;
}

/** A group produced together (MCP or a curated bundle) whose members appear when expanded. */
export interface Toolset {
  readonly name: string;
  readonly describe: string;
}

export function tool<Input, Output>(name: string, describe: string): Tool<Input, Output> {
  return { name, describe };
}

export function toolset(name: string, describe: string): Toolset {
  return { name, describe };
}

/** What a tool handler sees and does. It may re-run on resume, so it owns its idempotency. */
export interface ToolContext {
  thread: ThreadId;
  openStream(type: EventType): Stream; // open a fresh, logged stream scoped to this thread
  runFlow: (flow: Graph, initialPrompt: Message) => Promise<unknown>;
}

/** The implementation behind a tool, written by the flow author. */
export type ToolHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: ToolContext,
) => Promise<Output>;

/** Binds a reference to its implementation. Mixing `provide`/`expand` targets is a compile error. */
export type Binding =
  | { kind: "tool"; tool: Tool; handler: ToolHandler }
  | { kind: "toolset"; toolset: Toolset; discover: () => Promise<Record<string, ToolHandler>> };

export function provide<Input, Output>(
  ref: Tool<Input, Output>,
  handler: ToolHandler<Input, Output>,
): Binding {
  return { kind: "tool", tool: ref, handler: handler as ToolHandler };
}

export function expand(
  toolset: Toolset,
  discover: () => Promise<Record<string, ToolHandler>>,
): Binding {
  return { kind: "toolset", toolset, discover };
}
