import { describe, it, expect } from "vitest";
import { chat, ready, missing, missingTool, result } from "./basic.js";

describe("running-flows/basic", () => {
  it("reports no Missing entries for the correctly-wired flow", () => {
    expect(missing).toEqual([]);
  });

  it("reports a Missing tool entry for the flow with an unbound tool", () => {
    expect(missingTool).toEqual([{ kind: "tool", model: "fake", tool: "lookup_order" }]);
  });

  it("runs the flow to completion and resolves with the terminal output", () => {
    expect(result).toEqual({ reply: "ok" });
  });

  it("builds a runtime ready to drive the flow", () => {
    expect(ready.store.events().length).toBeGreaterThan(0);
    expect(chat.name).toBe("chat");
  });
});
