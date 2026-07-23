// `submit_spec`'s definition only. Its whole job is to be `agentTurn`'s
// `finishOn` target and hand the asker's structured result forward to the
// `red` stage — its binding (in index.tsx) just echoes its own input back.

import { tool } from "@behalf-js/core";
import { z } from "zod";

export const submitSpec = tool<
  { page: string; description: string },
  { page: string; description: string }
>(
  "submit_spec",
  "Submit the finalized page spec once you have enough detail from the user.",
  z.object({ page: z.string(), description: z.string() }),
);
