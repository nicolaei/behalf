// The Learn "Reporting state" page's example for reading `stateChange` live,
// the way a consumer outside the graph would: no import of the graph itself,
// only the session store's own event stream.

import type { Event, SessionStore } from "@behalf-js/core";

// #region watch
export async function collectStateChanges(
  store: SessionStore,
  count: number,
): Promise<Event["stateChange"][]> {
  const changes: Event["stateChange"][] = [];
  for await (const envelope of store.changes()) {
    if (envelope.form !== "committed" || envelope.type !== "stateChange") continue;
    changes.push(envelope.event as Event["stateChange"]);
    if (changes.length >= count) return changes;
  }
  return changes;
}
// #endregion watch
