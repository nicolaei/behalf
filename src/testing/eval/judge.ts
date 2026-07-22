// Eval scorer — llmJudge. Pure logic, but exercises an injected judge
// dependency (faked in tests) — the one scorer with an external call.

import type { AssistantMessage } from "../../index.js";
import type { Bars, Scorer } from "./scorers.js";

/** The dependency llmJudge calls out to — injectable so tests never make a real model call. @public */
export interface Judge {
  rate(rubric: string, reply: AssistantMessage | undefined): Promise<number>;
}

/** No judge was configured and none was injected — production wiring is a separate concern from this pure scorer. */
const defaultJudge: Judge = {
  rate(): Promise<number> {
    throw new Error(
      "llmJudge: no Judge configured — pass one explicitly (llmJudge(rubric, bars, judge)), or wire a real model-backed Judge for production use",
    );
  },
};

/** An LLM rates `run.lastReply()` against `rubric`, 0..1. @public */
export function llmJudge(rubric: string, bars?: Bars, judge?: Judge): Scorer {
  return {
    name: `llmJudge(${rubric})`,
    minimumScore: bars?.minimumScore ?? 0.8,
    ...(bars?.minimumPassRate !== undefined ? { minimumPassRate: bars.minimumPassRate } : {}),
    score: (run) => (judge ?? defaultJudge).rate(rubric, run.lastReply()),
  };
}
