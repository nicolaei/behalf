import { describe, it, expect } from "vitest";
import { defineGraph, runFlow, userText, outputs } from "../../index.js";
import { storeOnlyRuntime } from "./support.js";

describe("chained `when` conditions before `otherwise`", () => {
  function classifyTo(value: number) {
    return defineGraph(`classify-${String(value)}`, (flow) => {
      const classify = flow.step(outputs(() => value));
      const isLow = flow.step(outputs(() => "low"));
      const isHigh = flow.step(outputs(() => "high"));
      const isOther = flow.step(outputs(() => "other"));

      flow.entry(classify);
      classify
        .when((v) => (v as number) < 10, isLow)
        .when((v) => (v as number) > 100, isHigh)
        .otherwise(isOther);
      isLow.then(flow.finish);
      isHigh.then(flow.finish);
      isOther.then(flow.finish);
    });
  }

  it("takes the first `when` when it matches, ignoring the rest", async () => {
    const result = await runFlow(classifyTo(1), userText("go"), await storeOnlyRuntime());

    expect(result).toBe("low");
  });

  it("takes the second `when` when the first doesn't match but the second does", async () => {
    const result = await runFlow(classifyTo(200), userText("go"), await storeOnlyRuntime());

    expect(result).toBe("high");
  });

  it("takes `otherwise` when neither `when` condition matches", async () => {
    const result = await runFlow(classifyTo(50), userText("go"), await storeOnlyRuntime());

    expect(result).toBe("other");
  });
});
