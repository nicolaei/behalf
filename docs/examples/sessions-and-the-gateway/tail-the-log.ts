// The Learn "Sessions and the gateway" page's example: small, reusable
// pieces built directly on SessionStore and Gateway, the seam a client on
// top of behalf actually touches. Exercised against a real running flow in
// tail-the-log.test.ts, not a mocked store, so the envelope sequencing this
// page describes is genuinely observed, not asserted against a shape someone
// wrote by hand.

import type {
  Envelope,
  EventType,
  Gateway,
  SessionId,
  SessionStore,
  UserMessage,
  WebSocketLike,
} from "@behalf-js/core";

// #region envelope
export function describeEnvelope(envelope: Envelope): string {
  if (envelope.form === "delta") return `delta on ${envelope.delta.correlationId}`;
  return `${envelope.form} ${envelope.type}: ${JSON.stringify(envelope.event)}`;
}
// #endregion envelope

// #region tail
export async function tailCommitted(
  store: SessionStore,
  onCommitted: (envelope: Extract<Envelope, { type: EventType }>) => void,
): Promise<void> {
  for await (const envelope of store.changes()) {
    if (envelope.form === "committed") onCommitted(envelope);
  }
}
// #endregion tail

// #region reconnect
export function reconnect(store: SessionStore, send: (envelope: Envelope) => void): Envelope[] {
  const replayed = store.events();
  for (const envelope of replayed) send(envelope);
  void (async () => {
    for await (const envelope of store.changes()) send(envelope);
  })();
  return replayed;
}
// #endregion reconnect

// #region gateway
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
// #endregion gateway
