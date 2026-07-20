// Id generation — the correlation/thread id generators every other runtime
// module reaches for, plus the injectable `idFactory` a `runtime()` config
// may supply in place of the default counters.

import type { ThreadId } from "../../flow/thread.js";
import type { Runtime } from "../runtime.js";

/** A `runtime()` config's custom `idFactory`, if it supplied one — keyed off the returned `Runtime` in a module-scoped `WeakMap` rather than the public type, so this stays an implementation detail (see docs/reference.md's `Runtime` interface). Absent means the default counter-based ids (see `defaultCorrelationId`/`defaultThreadId`) apply, unchanged from before ids became injectable. */
export const idFactories = new WeakMap<Runtime, () => string>();

let nextCorrelationId = 0;
/** The default correlation-id generator: an ever-incrementing module counter, unchanged from before ids became injectable via `runtime()`'s `idFactory`. */
function defaultCorrelationId(): string {
  nextCorrelationId += 1;
  return `correlation-${String(nextCorrelationId)}`;
}

let nextThreadId = 0;
/** The default thread-id generator: an ever-incrementing module counter, unchanged from before ids became injectable via `runtime()`'s `idFactory`. */
function defaultThreadId(): string {
  nextThreadId += 1;
  return `thread-${String(nextThreadId)}`;
}

/** A fresh correlation id for a logged event — the runtime's own `idFactory` if `runtime()` was given one, else the default counter. */
export function freshCorrelationId(runtime: Runtime): string {
  const custom = idFactories.get(runtime);
  return custom ? custom() : defaultCorrelationId();
}

/** A fresh thread id — the runtime's own `idFactory` if `runtime()` was given one, else the default counter. */
export function freshThreadId(runtime: Runtime): ThreadId {
  const custom = idFactories.get(runtime);
  return (custom ? custom() : defaultThreadId()) as ThreadId;
}
