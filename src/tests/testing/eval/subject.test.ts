import { describe, it, expect } from "vitest";
import type { Model } from "../../../index.js";
import { agent } from "../../../testing/eval/index.js";

describe("agent(name, profile).with(partial) re-profiles a Subject", () => {
  const sonnetModel: Model = {
    identifier: "sonnet",
    provider: "test",
    contextWindow: 1000,
    reasoning: [],
  };

  it("returns a Subject carrying the merged profile, same name", () => {
    const base = agent("storyAgent", { model: sonnetModel, system: "plan", tools: [] });
    const reprofiled = base.with({ reasoning: "high" });
    expect(reprofiled.name).toBe("storyAgent");
    expect(reprofiled.profile.reasoning).toBe("high");
    expect(reprofiled.profile.model).toBe(sonnetModel);
  });

  it("does not mutate the original agent's profile", () => {
    const base = agent("storyAgent", { model: sonnetModel, system: "plan", tools: [] });
    base.with({ reasoning: "high" });
    expect(base.profile.reasoning).toBeUndefined();
  });
});
