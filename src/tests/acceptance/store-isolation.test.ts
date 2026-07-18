import { describe, it, expect } from "vitest";
import { adapters } from "../../index.js";

describe.skip("two stores don't share state", () => {
  it("keeps one store's committed events and inbox invisible to another", () => {
    const storeA = adapters.stores.memoryStore();
    const storeB = adapters.stores.memoryStore();

    storeA.append({ message: { role: "system", content: [] } }, { type: "message" });
    storeA.submit({ role: "user", intent: "standard", content: [] });

    expect(storeB.events()).toEqual([]);
    expect(storeB.inbox()).toEqual([]);
  });
});
