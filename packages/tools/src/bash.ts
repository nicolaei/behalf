// Adapter — the standard `bash` tool binding.

import { z } from "zod";
import type { Binding } from "@behalf-js/core";

/** Standard tool binding that runs a shell command and returns its output. @public */
export const bash: Binding = {
  kind: "tool",
  tool: {
    name: "bash",
    describe: "Runs a shell command and returns its output.",
    schema: z.object({ command: z.string() }),
  },
  handler: () =>
    Promise.reject(new Error("the standard `bash` tool binding is not implemented yet.")),
};
