// Gateway — the only thing clients touch. See docs/reference.md § "Gateway".

import type { SessionId } from "../session/envelope.js";
// eslint-disable-next-line no-restricted-imports -- TODO(B2 step 6: reducers + replay slot) Gateway.submit takes a UserMessage; removed when submit takes a generic PendingEntry instead.
import type { UserMessage } from "../ai/message.js";

/**
 * Minimal shape the gateway needs from a socket. Swap for the real `ws` or
 * DOM `WebSocket` type once an adapter is implemented.
 * @public
 */
export interface WebSocketLike {
  send(data: string): void;
}

/**
 * `connect` attaches a client’s websocket to a session and streams every
 * envelope to it. `submit` puts a client message into the inbox.
 * @public
 */
export interface Gateway {
  connect(session: SessionId, socket: WebSocketLike): void;
  submit(session: SessionId, message: UserMessage): void;
}
