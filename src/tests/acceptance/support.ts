// Acceptance test support — DSL helpers, not part of the public library surface.

import { runtime, adapters } from "../../index.js";
import type { Runtime } from "../../index.js";

/**
 * A runtime with only a store — no model port, no tool bindings. For tests
 * whose flow never calls a model or a tool.
 */
export async function storeOnlyRuntime(): Promise<Runtime> {
  return runtime({
    models: () => {
      throw new Error("no model call expected in this test");
    },
    bindings: [],
    store: adapters.stores.memoryStore(),
  });
}
