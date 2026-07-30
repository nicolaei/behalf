import { describe, it, expect } from "vitest";
import { llmJudge } from "../../eval/judge.js";
import type { Judge } from "../../eval/judge.js";
import type { Run } from "../../eval/run.js";
import type { AssistantMessage } from "@behalf-js/core";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: "scripted",
    content: [{ type: "text", text }],
    usage: { input: 1, output: 1 },
  };
}

function run(reply: AssistantMessage | undefined): Run {
  return {
    output: undefined,
    world: undefined,
    tools: [],
    traversal: [],
    visits: [],
    usage: { input: 0, output: 0 },
    latency: 0,
    threads: [],
    lastReply: () => reply,
    messages: () => [],
  };
}

describe("llmJudge", () => {
  it("throws when no judge is injected and none is configured", async () => {
    const scorer = llmJudge("polite and on-topic", { minimumScore: 0.8 });
    await expect(scorer.score(run(assistant("hi")))).rejects.toThrow();
  });

  it("returns the injected judge's rate() result", async () => {
    const judge: Judge = { rate: () => Promise.resolve(0.75) };
    const scorer = llmJudge("polite and on-topic", { minimumScore: 0.8 }, judge);
    await expect(scorer.score(run(assistant("hi")))).resolves.toBe(0.75);
  });

  it("passes the rubric and run.lastReply() through to the judge", async () => {
    let seenRubric: string | undefined;
    let seenReply: AssistantMessage | undefined;
    const reply = assistant("hi there");
    const judge: Judge = {
      rate: (rubric, r) => {
        seenRubric = rubric;
        seenReply = r;
        return Promise.resolve(1);
      },
    };
    const scorer = llmJudge("polite and on-topic", { minimumScore: 0.8 }, judge);
    await scorer.score(run(reply));
    expect(seenRubric).toBe("polite and on-topic");
    expect(seenReply).toBe(reply);
  });

  it("carries the minimumScore from bars, with no implicit default", () => {
    const judge: Judge = { rate: () => Promise.resolve(1) };
    expect(llmJudge("rubric", { minimumScore: 0.6 }, judge).minimumScore).toBe(0.6);
  });

  it("carries an optional minimumPassRate from bars", () => {
    const judge: Judge = { rate: () => Promise.resolve(1) };
    const scorer = llmJudge("rubric", { minimumScore: 0.6, minimumPassRate: 0.9 }, judge);
    expect(scorer.minimumPassRate).toBe(0.9);
  });
});
