import { describe, it, expect } from "vitest";
import { StepUntilError } from "@behalf-js/testing";
import {
  stepOnceDemo,
  untilBlockedDemo,
  stepUntilFastDemo,
  stepUntilStalledDemo,
  stepUntilBudgetExceededDemo,
  fastNode,
  humanReplyNode,
} from "./step-through.js";

describe("step-through", () => {
  it("stepOnce runs the entry node and fans out into both branches, one call", async () => {
    const first = await stepOnceDemo();

    expect(first).toHaveLength(2);
    expect(first.every((lane) => lane.status === "active")).toBe(true);
    expect(first.map((lane) => lane.node).sort()).toEqual([fastNode.id, humanReplyNode.id].sort());
  });

  it("stepUntilBlocked drives to both lanes parked: one folded, one waiting on a message", async () => {
    const state = await untilBlockedDemo();

    const parked = state.filter((lane) => lane.status === "parked");
    expect(parked).toHaveLength(2);
    expect(parked.some((lane) => lane.waitingFor?.includes("resume"))).toBe(true);
    expect(parked.some((lane) => lane.waitingFor === undefined)).toBe(true);
  });

  it("stepUntil drives to a specific node and stops there", async () => {
    const state = await stepUntilFastDemo();

    expect(state.some((lane) => lane.node === fastNode.id)).toBe(true);
  });

  it('stepUntil throws StepUntilError("stalled") when every lane parks before the condition is met', async () => {
    await expect(stepUntilStalledDemo()).rejects.toMatchObject({ reason: "stalled" });
    await expect(stepUntilStalledDemo()).rejects.toBeInstanceOf(StepUntilError);
  });

  it('stepUntil throws StepUntilError("budget-exceeded") when maxSteps is spent on an active cycle', async () => {
    await expect(stepUntilBudgetExceededDemo()).rejects.toMatchObject({
      reason: "budget-exceeded",
    });
  });
});
