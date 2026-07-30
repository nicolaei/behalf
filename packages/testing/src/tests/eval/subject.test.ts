import { describe, it, expect } from "vitest";
import { agent } from "../../eval/subject.js";
import type { Profile } from "@behalf-js/core";

const baseProfile: Profile = {
  model: { identifier: "model-a", provider: "test", contextWindow: 1000, reasoning: [] },
  system: "you are a test persona",
  tools: [],
};

describe("agent", () => {
  it("carries name and profile", () => {
    const support = agent("support-triage", baseProfile);
    expect(support.name).toBe("support-triage");
    expect(support.profile).toBe(baseProfile);
  });

  it(".with(partial) returns a Subject whose profile is shallow-merged with the partial", () => {
    const support = agent("support-triage", baseProfile);
    const variant = support.with({ system: "you are a terse persona" });
    expect(variant.name).toBe("support-triage");
    expect(variant.profile).toEqual({ ...baseProfile, system: "you are a terse persona" });
  });

  it(".with(partial) does not mutate the original agent's profile", () => {
    const support = agent("support-triage", baseProfile);
    support.with({ system: "changed" });
    expect(support.profile.system).toBe("you are a test persona");
  });

  it(".with(partial) returns a new object, not the same reference as the original", () => {
    const support = agent("support-triage", baseProfile);
    const variant = support.with({});
    expect(variant).not.toBe(support);
    expect(variant.profile).not.toBe(support.profile);
  });

  it(".with({}) preserves every field of the original profile", () => {
    const support = agent("support-triage", baseProfile);
    expect(support.with({}).profile).toEqual(baseProfile);
  });
});
