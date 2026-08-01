// `memoryStore` is the reference implementation of `SessionStore`, so it runs the shared
// conformance suite here, in behalf's own CI. Every downstream host runs the same suite against
// its own store — which only means anything if the reference passes it first.

import { memoryStore } from "@behalf-js/stores";
import { sessionStoreConformance } from "../session-store-conformance.js";

sessionStoreConformance("memoryStore", () => memoryStore());
