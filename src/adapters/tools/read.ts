// Adapter — the standard `read` tool binding.

import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that reads file content from disk. @public */
export const read: Binding = {
  kind: "tool",
  tool: { name: "read", describe: "Reads file content from disk." },
  handler: () =>
    Promise.reject(new Error("the standard `read` tool binding is not implemented yet.")),
};
