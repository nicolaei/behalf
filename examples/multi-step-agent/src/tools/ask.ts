// The `ask` tool's definition only — its binding (backed by ask-bridge.ts)
// lives in index.tsx, next to submit-spec's binding, since both are
// UI-bound rather than doing real I/O.

import { tool } from "behalf";
import { z } from "zod";

export const ask = tool<{ question: string }, { answer: string }>(
  "ask",
  "Ask the user a clarifying question and wait for their answer.",
  z.object({ question: z.string() }),
);
