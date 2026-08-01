// Id generation — the correlation/scope id generators every other runtime
// module reaches for, plus the injectable `idFactory` a `runtime()` config
// may supply in place of the default counters.

import type { ScopeId } from "../graph/thread.js";
import type { Runtime } from "./runtime.js";

/** A `runtime()` config's custom `idFactory`, if it supplied one — keyed off the returned `Runtime` in a module-scoped `WeakMap` rather than the public type, so this stays an implementation detail (see docs/reference.md's `Runtime` interface). Absent means the default counter-based ids (see `defaultCorrelationId`/`defaultScopeId`) apply, unchanged from before ids became injectable. */
export const idFactories = new WeakMap<Runtime, () => string>();

let nextCorrelationId = 0;
/** The default correlation-id generator: an ever-incrementing module counter, unchanged from before ids became injectable via `runtime()`'s `idFactory`. */
function defaultCorrelationId(): string {
  nextCorrelationId += 1;
  return `correlation-${String(nextCorrelationId)}`;
}

let nextScopeId = 0;
/** The default scope-id generator: an ever-incrementing module counter, unchanged from before ids became injectable via `runtime()`'s `idFactory`. Prefixed `thread-` still — an on-disk id shape, not a public name, and changing it buys nothing. */
function defaultScopeId(): string {
  nextScopeId += 1;
  return `thread-${String(nextScopeId)}`;
}

/** A fresh correlation id for a logged event — the runtime's own `idFactory` if `runtime()` was given one, else the default counter. */
export function freshCorrelationId(runtime: Runtime): string {
  const custom = idFactories.get(runtime);
  return custom ? custom() : defaultCorrelationId();
}

/** A fresh scope id — the runtime's own `idFactory` if `runtime()` was given one, else the default counter. */
export function freshScopeId(runtime: Runtime): ScopeId {
  const custom = idFactories.get(runtime);
  return (custom ? custom() : defaultScopeId()) as ScopeId;
}
