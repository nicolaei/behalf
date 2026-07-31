// Systems running flows — ModelPort. See docs/reference.md § "ModelPort".

import type { Model } from "./model.js";
import type { Profile } from "./profile.js";
import type { Message, AssistantMessage } from "./message.js";
import type { DeltaSink } from "../session/envelope.js";

/**
 * The adapter for one model. It only responds — compaction is a normal response
 * with a summary prompt. Thinking blocks pass back unmodified; the provider
 * decides cross-turn retention, never the port.
 * @public
 */
export interface ModelPort {
  readonly model: Model;
  /** `signal`, when given, fires the instant the flow-level call is aborted
   * (see @behalf-js/core's graph-level abort routing) — a cooperative port
   * should pass it straight through to its own transport (e.g. `fetch`'s or
   * an SDK's own `signal` option) so the real request actually stops instead
   * of continuing to stream after the flow has already moved on. Optional
   * and provider-agnostic (a standard AbortSignal, not Anthropic- or
   * OpenAI-specific): a port that ignores it keeps working exactly as
   * before, just without real cancellation — `runModelCall`'s caller-side
   * guard (Stream's settled check) still protects the log either way.
   * @public */
  respond(
    profile: Profile,
    messages: Message[],
    stream: DeltaSink,
    signal?: AbortSignal,
  ): Promise<AssistantMessage>;
}
