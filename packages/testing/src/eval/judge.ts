// Eval scorer — llmJudge. The one scorer with an external call, so `Judge`
// is injectable — production wiring is a separate concern from this pure
// scorer, and tests never make a real model call.
//
// `bars` is mandatory here, not optional: a judged score is continuous, not
// boolean, so there's no honest universal pass bar. The caller always states
// their own `minimumScore` (and optionally `minimumPassRate`) for their own
// rubric.
//
// Phase 0: type surface only. Every function body throws "not implemented".

import type { AssistantMessage } from "@behalf-js/core";
import type { Bars, Scorer } from "./scorers.js";

/** The dependency llmJudge calls out to — injectable so tests never make a real model call. @public */
export interface Judge {
  rate(rubric: string, reply: AssistantMessage | undefined): Promise<number>;
}

/** An LLM rates `run.lastReply()` against `rubric`, 0..1. `bars` is required — a judged score is continuous, so there's no honest default pass bar. No `judge` injected and none configured throws. @public */
export function llmJudge(_rubric: string, _bars: Bars, _judge?: Judge): Scorer {
  throw new Error("not implemented");
}
