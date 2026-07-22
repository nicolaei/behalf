// Eval scorer — llmJudge. Pure logic, but exercises an injected judge
// dependency (faked in tests) — the one scorer with an external call.
//
// Stub only — see the epic's Story 10 architecture note for the concrete
// behaviour this earns.

import type { AssistantMessage } from "../../index.js";
import type { Bars, Scorer } from "./scorers.js";

/** The dependency llmJudge calls out to — injectable so tests never make a real model call. @public */
export interface Judge {
  rate(rubric: string, reply: AssistantMessage | undefined): Promise<number>;
}

function notImplemented(name: string): never {
  throw new Error(`${name}: not implemented`);
}

/** An LLM rates `run.lastReply()` against `rubric`, 0..1. @public */
export function llmJudge(rubric: string, bars?: Bars, judge?: Judge): Scorer {
  void rubric;
  void bars;
  void judge;
  return notImplemented("llmJudge");
}
