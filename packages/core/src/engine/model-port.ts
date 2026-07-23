// Systems running flows — ModelPort. See docs/reference.md § "ModelPort".

import type { Model } from "../flow/model.js";
import type { Profile } from "../flow/profile.js";
import type { Message, AssistantMessage } from "../flow/message.js";
import type { DeltaSink } from "../session/envelope.js";

/**
 * The adapter for one model. It only responds — compaction is a normal response
 * with a summary prompt. Thinking blocks pass back unmodified; the provider
 * decides cross-turn retention, never the port.
 * @public
 */
export interface ModelPort {
  readonly model: Model;
  respond(profile: Profile, messages: Message[], stream: DeltaSink): Promise<AssistantMessage>;
}
