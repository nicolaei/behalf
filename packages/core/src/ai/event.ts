// AI authoring — Event registry augmentation. See docs/reference.md § "Event".
//
// The ai extension's contribution to the OPEN `Event` registry (session/event.ts):
// message, toolCall, toolResult, compaction. This is a TYPE-ONLY declaration merge —
// the runtime code that actually constructs and appends these events (runModelCall,
// the tool executor, compaction) stays in runtime/ until B2.7 assembles the `ai()`
// extension and moves that code here. Splitting the types now and the code later is
// deliberate: it proves the registry is open by construction, without smuggling a
// bigger refactor into this step.

import type { Message } from "./message.js";

declare module "../session/event.js" {
  interface Event {
    message: { message: Message };
    toolCall: { correlationId: string; name: string; input: unknown };
    toolResult: { correlationId: string; output: unknown; isError?: boolean };
    compaction: { task?: Message; summary: Message; keepLast: number };
  }
}
