// Session store — public barrel.

export type { Event, EventType } from "./event.js";
export type {
  Envelope,
  CommittedEnvelope,
  Delta,
  DeltaSink,
  Stream,
  SessionId,
} from "./envelope.js";
export { isCommittedEnvelope } from "./envelope.js";
export type {
  SessionStore,
  PendingEntry,
  InboxMessage,
  AppendMeta,
  StreamMeta,
} from "./session-store.js";
