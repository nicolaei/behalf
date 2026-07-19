// Gateway — the only thing clients touch. See docs/reference.md § "Gateway".

import type { SessionId } from "../session/envelope.js";
import type { UserMessage } from "../flow/message.js";

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
