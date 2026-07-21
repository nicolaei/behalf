// Adapter — the standard `edit` tool binding.

import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that applies line-anchored edits to a file on disk. @public */
export const edit: Binding = {
  kind: "tool",
  tool: { name: "edit", describe: "Applies line-anchored edits to a file on disk." },
  handler: () =>
    Promise.reject(new Error("the standard `edit` tool binding is not implemented yet.")),
};
