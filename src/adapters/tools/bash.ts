// Adapter — the standard `bash` tool binding.

import type { Binding } from "../../flow/tool.js";

/** Standard tool binding that runs a shell command and returns its output. @public */
export const bash: Binding = {
  kind: "tool",
  tool: { name: "bash", describe: "Runs a shell command and returns its output." },
  handler: () =>
    Promise.reject(new Error("the standard `bash` tool binding is not implemented yet.")),
};
