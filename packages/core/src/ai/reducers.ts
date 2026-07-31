// The ai extension's replay folds: how message/compaction events rebuild a
// thread's history. Physically relocated out of runtime/routing.ts (B2.7) —
// `withMessage`/`withCompaction` themselves (the pure fold helpers) stay in
// runtime/routing.ts as shared primitives generic runtime code (tick.ts's own
// inline replay, StateTracker, applyThreadAction) still needs directly; these
// two reducers are the `EngineExtension.reducers` registration on top of them.

import type { Event } from "../session/index.js";
import type { Thread, ScopeStateReducer } from "../runtime/index.js";
import { withMessage, withCompaction } from "../runtime/index.js";

export const messageReducer: ScopeStateReducer = (state, event) => {
  const { message } = event.event as Event["message"];
  return withMessage(state as Thread, message);
};

export const compactionReducer: ScopeStateReducer = (state, event) => {
  return withCompaction(state as Thread, event.event as Event["compaction"]);
};
