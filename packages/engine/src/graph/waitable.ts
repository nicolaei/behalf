// Flow authoring — Waitable. See docs/reference.md.
// `userInput()`/`toolCall()` (the two built-in Waitable constructors) moved
// to ai/waitable.ts (B2.7) — they're ai-shaped (MessageKind/UserMessage), so
// they belong with the rest of ai's authoring surface. `requireInboxKind`/
// `inboxKindOf` stay here: they only ever read a Waitable's own structural
// self-description, never any message-shaped data and never a provider name.

import type { Envelope } from "../session/index.js";

/**
 * Describes a condition a `waitFor`/`interrupt` node parks on — a pure
 * function over the committed session log, no IO of its own. `provider`
 * names which kind of thing can satisfy it (checked at boot by
 * `satisfiesFlows` against registered `WaitableSource`s); `label` is a
 * human-readable identity for logs/debugging. The exact matching contract
 * (committed log vs. the pending inbox before consumption) is finalized by
 * the engine wiring, not by this type.
 * @public
 */
export interface Waitable<T> {
  readonly provider: string;
  readonly label: string;
  /**
   * Set by a waitable factory to opt this waitable into inbox-message waiting, and to name
   * the message kind the engine should check the pending inbox against. Absent means the
   * waitable is resolved the other way instead: purely through its own `match()` against the
   * committed log (a signal-based waitable), which also means `satisfiesFlows` requires a
   * registered `WaitableSource` for its provider.
   *
   * Deliberately opaque and neutral. Until B3.2 the engine asked `provider === "userInput"`
   * instead — ai's own name for its own factory, hardcoded into generic dispatch, so an
   * engine-only extension had to literally call its provider `"userInput"` to get inbox-waiting
   * at all. The question is structural ("does this thing want inbox-peeking behaviour?"), not a
   * matter of vocabulary anyone has to interpret, so the waitable simply says so itself and the
   * string stays inside `ai`'s `userInput()` factory where it belongs.
   */
  readonly inboxKind?: string;
  match(events: readonly Envelope[]): T | undefined;
}

/**
 * The message kind a waitFor/interrupt path has already established this `Waitable` parks on
 * — for the call sites that would have nothing sensible to do with its absence.
 */
export function requireInboxKind(waitable: Waitable<unknown>): string {
  const kind = inboxKindOf(waitable);
  if (kind === undefined)
    throw new Error(`waitable provider "${waitable.provider}" has no message kind`);
  return kind;
}

/**
 * Whether this `Waitable` parks on the pending inbox, and on which message kind — the engine's
 * bridge to `SessionStore.consume`/`waitForMessage`'s pending-inbox check, which reads one live
 * message at a time rather than replaying committed `Envelope`s the way `match` does.
 *
 * `undefined` for a waitable that declares no `inboxKind`: every waitFor/interrupt-arming path
 * uses this to tell the two resolution strategies apart, and resolves those through `match()`
 * against the committed log instead.
 */
export function inboxKindOf(waitable: Waitable<unknown>): string | undefined {
  return waitable.inboxKind;
}
