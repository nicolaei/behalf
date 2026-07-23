// Adapter — the standard `write` tool binding.

import { z } from "zod";
import type { Binding } from "@behalf-js/core";

/** Standard tool binding that writes content to a file on disk. @public */
export const write: Binding = {
  kind: "tool",
  tool: {
    name: "write",
    describe: "Writes content to a file on disk.",
    schema: z.object({ path: z.string(), content: z.string() }),
  },
  handler: () =>
    Promise.reject(new Error("the standard `write` tool binding is not implemented yet.")),
};
