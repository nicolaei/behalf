import { describe, it, expect } from "vitest";
import type { NodeId, ThreadId } from "../../../index.js";
import type { Run } from "../../../testing/graph/run.js";
import type { Usage } from "../../../index.js";
import { sequence, loop, containsTraversal } from "../../../testing/graph/traversal.js";

function fakeRun(traversal: Run["traversal"]): Run {
  return {
    output: undefined,
    world: {},
    tools: [],
    traversal,
    visits: [],
    usage: {} as Usage,
    latency: 0,
    threads: [],
    lastReply: () => undefined,
    messages: () => [],
  };
}

describe("containsTraversal", () => {
  const setupNode = "setup" as NodeId;
  const implementNode = "implement" as NodeId;
  const reviewNode = "review" as NodeId;
  const cleanupNode = "cleanup" as NodeId;
  const t1 = "t1" as ThreadId;

  it("matches a subsequence, ignoring nodes before, after, and between", () => {
    const run = fakeRun([
      { node: setupNode, thread: t1 },
      { node: implementNode, thread: t1 },
      { node: implementNode, thread: t1 },
      { node: reviewNode, thread: t1 },
      { node: cleanupNode, thread: t1 },
    ]);
    expect(() => {
      containsTraversal(run, sequence(loop(implementNode), reviewNode));
    }).not.toThrow();
  });

  it("throws when the subsequence order is violated", () => {
    const run = fakeRun([
      { node: reviewNode, thread: t1 },
      { node: implementNode, thread: t1 },
    ]);
    expect(() => {
      containsTraversal(run, sequence(implementNode, reviewNode));
    }).toThrow();
  });

  it("loop times: 0 fails when the node appears between the two matched elements, not just adjacent to the first", () => {
    // Bug report: containsTraversal's loop(times: 0) only checked adjacency
    // at the current offset, so a node appearing further along (but still
    // between the two real matches) went undetected — a no-op in the
    // subsequence matcher's most common disambiguation use case.
    const run = fakeRun([
      { node: setupNode, thread: t1 },
      { node: implementNode, thread: t1 }, // filler — makes cleanup non-adjacent to setup
      { node: cleanupNode, thread: t1 }, // occurs between setup and review, just not adjacent
      { node: reviewNode, thread: t1 },
    ]);
    expect(() => {
      containsTraversal(run, sequence(setupNode, loop(cleanupNode, { times: 0 }), reviewNode));
    }).toThrow();
  });
});
