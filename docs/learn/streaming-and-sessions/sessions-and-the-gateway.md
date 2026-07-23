# Sessions and the gateway

<!-- OUTLINE — skeleton only, no full prose yet. See docs/style-guide.md. -->

For anyone building their own client on top of behalf (like `examples/simple-chat`
does): the durable log/inbox/delta model underneath a session, and the
gateway that's the only thing a client ever touches.

## You will learn

- The `Event`/`Envelope` shapes and the three envelope `form`s (`committed`,
  `in-progress`, `delta`)
- The core `SessionStore` operations: `receive`/`consume`/`append`/`open`/`changes`
- How to tail the log to rebuild state, ignoring deltas and in-progress snapshots
- How a client reconnects: replay the committed log, then in-progress
  snapshots, then live deltas
- What `Gateway.connect`/`submit` do, and why many clients can share one
  session

## Event and Envelope

_No `type` field on the event itself — the envelope names it. Example ref:
`docs/examples/sessions-and-the-gateway/tail-the-log.ts#envelope`._

## SessionStore

_`receive` onto one shared pending queue; `consume` finds-and-removes;
`append` commits; `open` starts a streaming event. TODO._

## Tailing the log

_`for await (const envelope of store.changes())`. Example ref: `#tail`._

## Reconnecting

_Replay `events()`, then the store emits `in-progress` + deltas. Example ref:
`#reconnect`._

## Gateway

_`connect`/`submit`; a client message is a `user` message with `intent`.
Example ref: `#gateway`._

## Recap

- TODO — mirror "You will learn," past tense.

---

**Reference:** reference.md § Session store (full block), § Gateway (full block).
**Examples:** `docs/examples/sessions-and-the-gateway/tail-the-log.ts` — regions: `envelope`, `tail`, `reconnect`, `gateway`.
**Section:** [Streaming and sessions](./README.md)
**Prev:** [Streaming progress](./streaming-progress.md)
