// Adapter — the standard `edit` tool binding.

import { z } from "zod";
import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that applies line-anchored edits to a file on disk. @public */
export const edit: Binding = {
  kind: "tool",
  tool: {
    name: "edit",
    describe: "Applies line-anchored edits to a file on disk.",
    schema: z.record(z.string(), z.unknown()),
  },
  handler: () =>
    Promise.reject(new Error("the standard `edit` tool binding is not implemented yet.")),
};
