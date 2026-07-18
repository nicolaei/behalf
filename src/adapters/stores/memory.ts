// Adapter — an in-memory SessionStore. For tests and local dev, not production.

import type { SessionStore } from "../../engine/session-store.js";

export declare function memoryStore(): SessionStore;
