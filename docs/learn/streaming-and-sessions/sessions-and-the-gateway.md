# Sessions and the gateway

For anyone building their own client on top of behalf (the way `examples/simple-chat` does): the
durable log/inbox/delta model underneath a session, and the gateway that's the only thing a client
ever touches.

## You will learn

- How to tell an `Event` from the `Envelope` that wraps it, and what its three `form`s mean
- How to work a `SessionStore`'s queue and log: `receive`/`consume`, `append`/`open`, and reading
  everything back with `events()`/`changes()`
- How to tail the log to rebuild state, ignoring deltas and in-progress snapshots
- How a client reconnects: replay the committed log, then in-progress snapshots, then live deltas
- How `Gateway.connect`/`submit` work, and why many clients can share one session

## Event and Envelope

An `Event` is the payload of a durable fact: a `message`, an `output`, a `toolCall`, and so on.
It carries no `type` field of its own; the wrapper around it, `Envelope`, names which kind it is.

```ts source=docs/examples/sessions-and-the-gateway/tail-the-log.ts#envelope
export function describeEnvelope(envelope: Envelope): string {
  if (envelope.form === "delta") return `delta on ${envelope.delta.correlationId}`;
  return `${envelope.form} ${envelope.type}: ${JSON.stringify(envelope.event)}`;
}
```

You might expect `envelope.event.type` to tell you what you're looking at, since that's how a lot of
tagged-union wire formats work.
Here it's the other way around: the event itself is a plain, untagged shape, and `envelope.type`
(present on every form except `delta`) is the only place the kind lives.
A `delta` envelope has no `event`/`type` at all: it carries a `Delta` fragment instead, tagged by
the `correlationId` of the stream it belongs to, not by an event type.

## SessionStore

A session is a `SessionStore`: one committed log, one pending queue, and a live delta stream, all
scoped to one session.

`receive` adds a pending entry, a real `message` or a non-conversational `signal`, onto one shared
queue that preserves arrival order across both kinds. `consume` finds and removes a pending entry in
one call: how the engine drains it at a `waitFor` node. `append` commits an event straight into the
log. `open` is `openStream`'s other half: it's what a `StepContext`/`ToolContext` call actually
reaches, returning the `Stream` covered in [Streaming progress](./streaming-progress.md).
`changes()` is the live feed: every envelope, of every form, as it happens.

> [!NOTE] Deltas never touch the log. `store.events()` only ever returns committed envelopes; a
> delta only ever reaches a live `changes()` subscriber, which is why tailing and reconnecting
> (below) treat it differently from everything else `SessionStore` produces.

## Tailing the log

A client that just wants to keep its own view of the session up to date subscribes to `changes()`
and ignores anything that isn't settled.

```ts source=docs/examples/sessions-and-the-gateway/tail-the-log.ts#tail
export async function tailCommitted(
  store: SessionStore,
  onCommitted: (envelope: Extract<Envelope, { type: EventType }>) => void,
): Promise<void> {
  for await (const envelope of store.changes()) {
    if (envelope.form === "committed") onCommitted(envelope);
  }
}
```

`for await` here never ends on its own: a session's `changes()` stream stays open for as long as the
session does, the same reason a `waitFor` node can park indefinitely instead of polling.
Filtering to `"committed"` is what makes this safe to fold into state: an `in-progress` snapshot or
a `delta` can still change before anything is final, but a committed envelope never will.

## Reconnecting

A client that already has some history (it disconnected and came back, or just opened for the first
time on a session mid-run) needs both: the settled past, and whatever's happening right now.

```ts source=docs/examples/sessions-and-the-gateway/tail-the-log.ts#reconnect
export function reconnect(store: SessionStore, send: (envelope: Envelope) => void): Envelope[] {
  const replayed = store.events();
  for (const envelope of replayed) send(envelope);
  void (async () => {
    for await (const envelope of store.changes()) send(envelope);
  })();
  return replayed;
}
```

`store.events()` replays the committed log first, in order, exactly once.
Only after that does `changes()` start delivering anything new: an `in-progress` envelope the moment
a stream opens, then its `delta`s as they arrive, then a final `committed` envelope (`aborted: true`
if the stream aborted) once it settles.
Replaying before subscribing is what makes this order safe: a client can't see a live envelope
twice, once from the tail of history and once from the live feed, because the live feed only starts
after the replay finishes.

## Gateway

The `Gateway` is the seam a client actually touches: it never sees a `SessionStore` directly.

```ts source=docs/examples/sessions-and-the-gateway/tail-the-log.ts#gateway
export function createGateway(sessions: Map<SessionId, SessionStore>): Gateway {
  function storeFor(session: SessionId): SessionStore {
    const store = sessions.get(session);
    if (!store) throw new Error(`no session ${String(session)}`);
    return store;
  }

  return {
    connect(session: SessionId, socket: WebSocketLike): void {
      const store = storeFor(session);
      for (const envelope of store.events()) socket.send(JSON.stringify(envelope));
      void (async () => {
        for await (const envelope of store.changes()) socket.send(JSON.stringify(envelope));
      })();
    },
    submit(session: SessionId, message: UserMessage): void {
      storeFor(session).receive({ kind: "message", message });
    },
  };
}
```

`connect` is the reconnect logic above, wired to a socket instead of a plain callback. `submit` puts
a client message into the inbox: a `user` message carrying an `intent` (`standard` for a prompt or
follow-up, `steering` for a mid-turn nudge, `abort` to cancel).
Because a `Gateway` only exposes `connect` and `submit`, any number of clients can attach to the
same session: each just replays the log and tails `changes()` on its own, and a submitted message
lands in the one shared inbox regardless of which client sent it.

## Recap

- An `Event` carries no `type` of its own; `Envelope` names it, and has three `form`s: `committed`,
  `in-progress`, and `delta`
- `SessionStore` holds the committed log, the pending queue, and the live delta stream:
  `receive`/`consume` work the queue, `append`/`open` commit, `events()` replays the log, and
  `changes()` tails everything live
- Tailing the log means filtering `changes()` down to `"committed"` and ignoring the rest
- Reconnecting replays `store.events()` first, then lets `changes()` take over: in-progress, deltas,
  and new commits
- `Gateway.connect`/`submit` are the only two operations a client needs; any number of clients can
  share one session

---

**Reference:** reference.md § Session store (full block), § Gateway (full block). **Examples:**
`docs/examples/sessions-and-the-gateway/tail-the-log.ts`, regions `envelope`, `tail`, `reconnect`,
`gateway`. **Section:** [Streaming and sessions](./README.md) **Prev:**
[Streaming progress](./streaming-progress.md)
