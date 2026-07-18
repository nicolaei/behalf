// Flow authoring — defineGraph. See docs/reference.md § "defineGraph".

import type { Step } from "./step.js";
import type { Message, MessageKind } from "./message.js";
import type { ThreadAction } from "./thread.js";

export type NodeId = string & { readonly __brand: "NodeId" };

/** A composed, runnable flow. Opaque — its shape settles once `defineGraph` is implemented. */
export interface Graph {
  readonly name: string;
}

export interface EdgeOptions {
  threadAction?: ThreadAction; // omitted = "same"
  prompt?: (output: unknown) => Message;
}

export interface Handle {
  when(condition: (output: unknown) => boolean, to: Handle, options?: EdgeOptions): Handle;
  otherwise(to: Handle, options?: EdgeOptions): Handle;
  then(to: Handle, options?: EdgeOptions): void; // continue to one node
  then(to: Handle[], options?: EdgeOptions): Group; // fan out — each on its own thread
}

export interface Group {
  join(to: Handle, options?: EdgeOptions): void; // run `to` once when every branch finishes
}

export interface Flow {
  step<Result>(run: Step<Result>, options?: { label?: string }): Handle;
  use(subgraph: Graph): Handle; // compose a graph as a node; runs on the reaching edge's thread
  waitFor(kind: MessageKind): Handle; // park until a matching message is in the inbox
  interrupt(kind: MessageKind, run: Step): Handle; // always armed
  entry(node: Handle): void;
  readonly finish: Handle; // route a value in to end the flow; that value is the result
}

export declare function defineGraph(name: string, build: (flow: Flow) => void): Graph;
