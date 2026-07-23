import { describe, it, expect } from "vitest";
import { memoryStore } from "@behalf-js/stores";

describe("two stores don't share state", () => {
  it("keeps one store's committed events and inbox invisible to another", () => {
    const storeA = memoryStore();
    const storeB = memoryStore();

    storeA.append({ message: { role: "system", content: [] } }, { type: "message" });
    storeA.receive({ kind: "message", message: { role: "user", intent: "standard", content: [] } });

    expect(storeB.events()).toEqual([]);
    expect(storeB.inbox()).toEqual([]);
  });
});
