// Adapter — the standard `write` tool binding.

import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that writes content to a file on disk. @public */
export const write: Binding = {
  kind: "tool",
  tool: { name: "write", describe: "Writes content to a file on disk." },
  handler: () =>
    Promise.reject(new Error("the standard `write` tool binding is not implemented yet.")),
};
