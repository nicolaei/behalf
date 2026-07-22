import { describe, it, expect } from "vitest";
import type { NodeId, ThreadId } from "../../../index.js";
import type { Run } from "../../../testing/graph/run.js";
import type { Usage } from "../../../index.js";
import {
  sequence,
  group,
  loop,
  branch,
  matchesTraversal,
} from "../../../testing/graph/traversal.js";

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

describe("matchesTraversal", () => {
  const n1 = "n1" as NodeId;
  const n2 = "n2" as NodeId;
  const n3 = "n3" as NodeId;
  const a = "a" as NodeId;
  const b = "b" as NodeId;
  const implementNode = "implement" as NodeId;
  const escalateNode = "escalate" as NodeId;
  const t1 = "t1" as ThreadId;

  it("passes when the traversal matches the tree exactly", () => {
    const run = fakeRun([
      { node: n1, thread: t1 },
      { node: n2, thread: t1 },
    ]);
    expect(() => {
      matchesTraversal(run, sequence(n1, n2));
    }).not.toThrow();
  });

  it("throws with a diff pointing at the diverging node", () => {
    const run = fakeRun([
      { node: n1, thread: t1 },
      { node: n3, thread: t1 },
    ]);
    expect(() => {
      matchesTraversal(run, sequence(n1, n2));
    }).toThrow(/n2/);
  });

  it("group allows either branch order", () => {
    const run = fakeRun([
      { node: b, thread: t1 },
      { node: a, thread: t1 },
    ]);
    expect(() => {
      matchesTraversal(run, group(a, b));
    }).not.toThrow();
  });

  it("loop matches a repeated node, optionally asserting times", () => {
    const run = fakeRun([
      { node: implementNode, thread: t1 },
      { node: implementNode, thread: t1 },
    ]);
    expect(() => {
      matchesTraversal(run, loop(implementNode, { times: 2 }));
    }).not.toThrow();
  });

  it("branch requires exactly one of the routed nodes to have fired", () => {
    const run = fakeRun([{ node: escalateNode, thread: t1 }]);
    expect(() => {
      matchesTraversal(run, branch(escalateNode));
    }).not.toThrow();
  });

  it("loop times: 0 passes when the node never appears", () => {
    const run = fakeRun([{ node: n1, thread: t1 }]);
    expect(() => {
      matchesTraversal(run, sequence(n1, loop(implementNode, { times: 0 })));
    }).not.toThrow();
  });
});
