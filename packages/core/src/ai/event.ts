// AI authoring — Event registry augmentation. See docs/reference.md § "Event".
//
// The ai extension's contribution to the OPEN `Event` registry (session/event.ts):
// message, toolCall, toolResult, compaction, threadGenesis.

import type { ScopeId } from "../graph/thread.js";
import type { Message } from "./message.js";

declare module "../session/event.js" {
  interface Event {
    message: { message: Message };
    toolCall: { correlationId: string; name: string; input: unknown };
    toolResult: { correlationId: string; output: unknown; isError?: boolean };
    compaction: { task?: Message; summary: Message; keepLast: number };
    /** A freshly-derived scope's genesis fact — what `ctx.thread.start`/`fork` (and
     * `context.invalidate`'s own `seedScope` hook, when ai is registered) append the
     * instant a scope is minted, baking in its starting content: an empty `seed` for
     * `start()` with no message, `[reason]` for one with a message, or a fork's copied
     * history up to the split point (`forkedFrom.at`), plus its own new message if any. */
    threadGenesis: { seed: Message[]; forkedFrom?: { thread: ScopeId; at: number } };
  }
}
