// Test support for this package's own tests — small, local copies of the
// handful of helpers `packages/core`'s acceptance suite also defines. Kept
// local rather than shared across packages: these are trivial one-liners,
// not worth a cross-package test dependency.

import type { Message, SessionStore } from "@behalf-js/core";

/** A model resolver for tests whose flow is expected to never call a model. */
export function neverCalled(): never {
  throw new Error("no model call expected in this test");
}

/** Pulls the first text block's text out of a message, for assertions. */
export function textOf(message: Message | undefined): string {
  const block = message?.content.find((candidate) => candidate.type === "text");
  return block?.type === "text" ? block.text : "";
}

/** Submits a scripted "approval" message a parked waitFor/branch is waiting on. */
export function submitApproval(store: SessionStore): void {
  store.receive({
    kind: "message",
    message: {
      role: "user",
      intent: "standard",
      kind: "approval",
      content: [{ type: "text", text: "yes" }],
    },
  });
}
