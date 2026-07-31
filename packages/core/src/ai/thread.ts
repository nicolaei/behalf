// AI authoring — Thread, ThreadApi, and the replay folds that rebuild a
// thread's history from the log. Physically relocated out of runtime/routing.ts
// (B2 step 8, thread extraction): "thread" (a conversation — message history,
// start/fork/say/end) is an ai word, not a core one. Core keeps only the
// opaque `ScopeId` and its minimal, ai-neutral `ScopeAction` lifecycle
// primitive (see graph/thread.ts); everything about WHAT a thread's content
// is, and how it's rebuilt, lives here.

import type { ScopeId } from "../graph/thread.js";
import type { ExecutionScope, ScopeStateReducer } from "../runtime/index.js";
import type { Event } from "../session/index.js";
import type { Message } from "./message.js";

/** A thread's replayed state: the assembled view (`messages` — compaction applied, tail
 * trimmed) and the full record (`history`, including compaction messages), keyed by the
 * scope it lives on. Extension scope state — rebuilt by this file's own reducers, never a
 * field on core's generic replay state. @public */
export interface Thread {
  readonly id: ScopeId;
  readonly label?: string | undefined;
  readonly forkedFrom?: { thread: ScopeId; at: number } | undefined;
  readonly messages: Message[];
  readonly history: Message[];
}

function emptyThread(scope: ScopeId): Thread {
  return { id: scope, messages: [], history: [] };
}

/** Returns a new thread with `message` appended to both its assembled view and its full history — never mutates the thread passed in. */
export function withMessage(thread: Thread, message: Message): Thread {
  return {
    ...thread,
    messages: [...thread.messages, message],
    history: [...thread.history, message],
  };
}

/**
 * Derives the `messages` a `"compaction"` event produces, given the thread's
 * own `history` up to that point: an optional restated `task`, the
 * synthesized `summary`, then the last `keepLast` messages pulled straight
 * out of `history` — never duplicated content, just a pointer back into it.
 */
export function deriveCompactedMessages(
  history: readonly Message[],
  compaction: Event["compaction"],
): Message[] {
  const { task, summary, keepLast } = compaction;
  const tail = history.slice(Math.max(0, history.length - keepLast));
  return [...(task ? [task] : []), summary, ...tail];
}

/** Returns a new thread with `messages` replaced per a compaction event — `history` untouched, since only `"message"`/`"threadGenesis"` events ever extend it. Never mutates the thread passed in. */
export function withCompaction(thread: Thread, compaction: Event["compaction"]): Thread {
  return { ...thread, messages: deriveCompactedMessages(thread.history, compaction) };
}

/** Folds a committed `message` event into a thread's state — `state` starts `undefined` until a scope's first fold, initialized to an empty thread on that scope. */
export const messageReducer: ScopeStateReducer = (state, event, scope) => {
  const { message } = event.event as Event["message"];
  return withMessage((state as Thread | undefined) ?? emptyThread(scope), message);
};

/** Distinguishes a real `Message` from a plain marker value — an `input` event's `value` is
 * `unknown` (see `Event["input"]`); this is what lets `inputReducer` recognize a Message-shaped
 * one (the common case: a session's own starting user message, appended by `seed()`) and fold
 * it in exactly like an ordinary `message` event, without misreading a non-message starting
 * value (e.g. a plain string or marker) as one. Mirrors `packages/testing`'s own copy, kept in
 * sync manually since this isn't part of core's public surface. */
function looksLikeMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && "role" in value && "content" in value;
}

/** Folds a committed `input` event into a thread's state — `seed()`'s own starting value, when
 * it's message-shaped (the common case). A non-message seed (e.g. a plain string) leaves the
 * thread untouched: nothing for ai to fold, some other extension's own concern instead. */
export const inputReducer: ScopeStateReducer = (state, event, scope) => {
  const { value } = event.event as Event["input"];
  if (!looksLikeMessage(value)) return state;
  return withMessage((state as Thread | undefined) ?? emptyThread(scope), value);
};

/** Folds a committed `compaction` event into a thread's state. */
export const compactionReducer: ScopeStateReducer = (state, event, scope) => {
  return withCompaction(
    (state as Thread | undefined) ?? emptyThread(scope),
    event.event as Event["compaction"],
  );
};

/** Folds a committed `threadGenesis` event — the one event `ctx.thread.start`/`fork` (and
 * `context.invalidate`'s own `seedScope` hook) append onto a freshly-derived scope, baking
 * in whatever content it starts with (a fork's copied history up to the split point, or a
 * blank slate) in one committed fact rather than requiring cross-scope replay reads. Always
 * re-initializes state (a scope only ever gets one genesis, its very first event). */
export const threadGenesisReducer: ScopeStateReducer = (_state, event, scope) => {
  const { seed, forkedFrom } = event.event as Event["threadGenesis"];
  return {
    id: scope,
    ...(forkedFrom ? { forkedFrom } : {}),
    messages: [...seed],
    history: [...seed],
  } satisfies Thread;
};

/** This scope's currently-folded thread state, or an empty one if nothing's landed yet. */
function currentThread(scope: ExecutionScope): Thread {
  return (scope.state("ai") as Thread | undefined) ?? emptyThread(scope.scope);
}

/** The thread API — merged into StepContext and EdgeContext (see ai/context.ts). @public */
export interface ThreadApi {
  /** New conversation, seeded with its first message (the prompt IS the first action). Omit the message to start on a genuinely blank scope. */
  start(message?: Message): void;
  /** A new scope sharing history up to the split point, optionally seeded with one more message. */
  fork(message?: Message): void;
  /** Continues this scope with one more message — no scope transition. */
  say(message: Message): void;
  /** Marks this scope's conversation as ended. No persisted effect today — a placeholder for
   * a future lifecycle event nothing in this library's own replay currently reads back. */
  end(): void;
}

/** `ThreadApi`'s action methods, the same readable properties `context.thread` has always
 * exposed, plus `parentThreadId` — the scope that spawned this one as a child (a tool's own
 * `runFlow` call), if any. Ownership, not ancestry (distinct from `forkedFrom`; see
 * `graph/thread.ts`'s own doc comment). Live/in-memory only — sourced from
 * `ExecutionScope.parentScope`, never durably logged, exactly as before this scope's own
 * extraction: a later replay of the same session never reconstructs it. One object, per
 * fork-3's resolution (ai/'s own latitude on this shape; see task notes). */
export type ThreadContext = ThreadApi &
  Pick<Thread, "id" | "label" | "forkedFrom" | "messages" | "history"> & {
    readonly parentThreadId?: ScopeId | undefined;
  };

/** Builds the `ctx.thread` value contributed to a `StepContext`/`EdgeContext` — shared by
 * `ai/extension.ts`'s `stepContext`/`edgeContext` hooks, since both merge in the identical
 * shape. `getLabel`, given only for a StepContext (an edge has no "currently running node"
 * of its own), backs `thread.label`. */
export function buildThreadContext(
  scope: ExecutionScope,
  getLabel?: () => string | undefined,
): ThreadContext {
  return {
    start(message) {
      scope.deriveScope("new");
      scope.appendEvent({ seed: message ? [message] : [] }, "threadGenesis");
    },
    fork(message) {
      const parent = currentThread(scope);
      const parentId = scope.scope;
      const history = parent.history;
      scope.deriveScope("fork");
      scope.appendEvent(
        {
          seed: message ? [...history, message] : [...history],
          forkedFrom: { thread: parentId, at: history.length },
        },
        "threadGenesis",
      );
    },
    say(message) {
      scope.appendEvent({ message }, "message");
    },
    end() {
      // No persisted effect — see this method's own doc comment on ThreadApi.
    },
    get id() {
      return scope.scope;
    },
    get label() {
      return getLabel?.();
    },
    get forkedFrom() {
      return currentThread(scope).forkedFrom;
    },
    get messages() {
      return currentThread(scope).messages;
    },
    get history() {
      return currentThread(scope).history;
    },
    get parentThreadId() {
      return scope.parentScope;
    },
  };
}

/** Edge-function sugar over `ctx.thread.start` — see `ai/context.ts`'s `EdgeFn` re-export.
 * Tags the returned function with `.scopeAction = "new"`, purely so reflective tooling
 * (`tools/graph-to-mermaid.ts`) can still label a non-default scope action on the diagram
 * without `EdgeOptions` carrying one — mirrors how it already detects a persona/join step
 * off a marker property, rather than a discriminated field. @public */
export function startThread(fn: (output: unknown) => Message | undefined) {
  const run = (output: unknown, ctx: { thread: ThreadApi }): unknown => {
    ctx.thread.start(fn(output));
    return output;
  };
  run.scopeAction = "new" as const;
  return run;
}

/** Edge-function sugar over `ctx.thread.fork` — see `startThread`'s own doc comment. @public */
export function forkThread(fn: (output: unknown) => Message | undefined) {
  const run = (output: unknown, ctx: { thread: ThreadApi }): unknown => {
    ctx.thread.fork(fn(output));
    return output;
  };
  run.scopeAction = "fork" as const;
  return run;
}
