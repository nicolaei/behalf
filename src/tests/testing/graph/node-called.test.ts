import { describe, it, expect } from "vitest";
import type { NodeId, ThreadId } from "../../../index.js";
import type { Run, NodeVisit } from "../../../testing/graph/run.js";
import type { Usage } from "../../../index.js";
import { nodeCalled } from "../../../testing/graph/node.js";

function fakeRunWithVisits(visits: NodeVisit[]): Run {
  return {
    output: undefined,
    world: {},
    tools: [],
    traversal: [],
    visits,
    usage: {} as Usage,
    latency: 0,
    threads: [],
    lastReply: () => undefined,
    messages: () => [],
  };
}

describe("nodeCalled", () => {
  const implementNode = "implement" as NodeId;
  const t1 = "t1" as ThreadId;

  it("passes when the node was visited at least once by default", () => {
    const run = fakeRunWithVisits([
      { node: implementNode, input: [], output: "patched", thread: t1 },
    ]);
    expect(() => {
      nodeCalled(run, implementNode);
    }).not.toThrow();
  });

  it("checks the exact visit count when times is given", () => {
    const run = fakeRunWithVisits([
      { node: implementNode, input: [], output: "patched", thread: t1 },
    ]);
    expect(() => {
      nodeCalled(run, implementNode, { times: 2 });
    }).toThrow(/1/);
  });

  it("checks output against a predicate", () => {
    const run = fakeRunWithVisits([
      { node: implementNode, input: [], output: "patched", thread: t1 },
    ]);
    expect(() => {
      nodeCalled(run, implementNode, { output: (o) => o === "patched" });
    }).not.toThrow();
    expect(() => {
      nodeCalled(run, implementNode, { output: (o) => o === "wrong" });
    }).toThrow();
  });
});
