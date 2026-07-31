// AI authoring — StepContext/EdgeContext augmentation. See docs/reference.md
// § "The extension seam". Type-only declaration merge: the ai extension
// augments both context types with `thread`, so flow authors see one
// seamless `StepContext`/`EdgeContext` — the runtime piece that actually
// builds the value lives in ai/extension.ts's `stepContext`/`edgeContext`
// hooks (see ai/thread.ts's `buildThreadContext`).

import type { ThreadContext } from "./thread.js";

declare module "../graph/step.js" {
  interface StepContext {
    thread: ThreadContext;
  }
}

declare module "../graph/graph.js" {
  interface EdgeContext {
    thread: ThreadContext;
  }
}
