// Flow authoring — tool / toolset / ToolHandler / provide / expand. See docs/reference.md.

import type { ThreadId } from "./thread.js";
import { z } from "zod";
import type { Message } from "./message.js";
import type { Graph } from "./graph.js";
import type { Stream } from "../session/envelope.js";
import type { EventType } from "../session/event.js";

/** One typed capability. `_input`/`_output` are phantom — never populated, used for inference. @public */
export interface Tool<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly describe: string;
  readonly schema: z.ZodType<Input>;
  readonly _input?: Input;
  readonly _output?: Output;
}

/** A group produced together (MCP or a curated bundle) whose members appear when expanded. @public */
export interface Toolset {
  readonly name: string;
  readonly describe: string;
}

/** Creates a typed tool reference by name and description. @public */
export function tool<Input, Output>(
  name: string,
  describe: string,
  schema: z.ZodType<Input> = z.record(z.string(), z.unknown()) as z.ZodType<Input>,
): Tool<Input, Output> {
  return { name, describe, schema };
}

/** Creates a typed toolset reference by name and description. @public */
export function toolset(name: string, describe: string): Toolset {
  return { name, describe };
}

/** What a tool handler sees and does. It may re-run on resume, so it owns its idempotency. @public */
export interface ToolContext {
  thread: ThreadId;
  openStream(type: EventType): Stream; // open a fresh, logged stream scoped to this thread
  runFlow: (flow: Graph, initialPrompt: Message) => Promise<unknown>;
}

/** The implementation behind a tool, written by the flow author. @public */
export type ToolHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: ToolContext,
) => Promise<Output>;

/** Binds a reference to its implementation. Mixing `provide`/`expand` targets is a compile error. @public */
export type Binding =
  | { kind: "tool"; tool: Tool; handler: ToolHandler }
  | { kind: "toolset"; toolset: Toolset; discover: () => Promise<Record<string, ToolHandler>> };

/** Binds a concrete handler to a tool reference. @public */
export function provide<Input, Output>(
  ref: Tool<Input, Output>,
  handler: ToolHandler<Input, Output>,
): Binding {
  return { kind: "tool", tool: ref, handler: handler as ToolHandler };
}

/** Registers a discover callback that expands a toolset into its member handlers. @public */
export function expand(
  toolset: Toolset,
  discover: () => Promise<Record<string, ToolHandler>>,
): Binding {
  return { kind: "toolset", toolset, discover };
}
