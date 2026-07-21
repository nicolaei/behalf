// Adapter — the standard `read` tool binding.

import { z } from "zod";
import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that reads file content from disk. @public */
export const read: Binding = {
  kind: "tool",
  tool: {
    name: "read",
    describe: "Reads file content from disk.",
    schema: z.object({ path: z.string() }),
  },
  handler: () =>
    Promise.reject(new Error("the standard `read` tool binding is not implemented yet.")),
};
